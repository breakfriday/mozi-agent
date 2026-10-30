//! Wordcraft 0.6.1 stdio MCP adapter. Only job: assistant Markdown text → `Raster`.
//! One worker thread, one replaceable job list; layout and composition live on the main thread.
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use super::board::{Layout, Raster};
use crate::render_config::{MARKDOWN_MARGIN, MARKDOWN_SCALE};

type Result<T> = std::result::Result<T, String>;

pub struct Job {
    pub id: u64,
    pub text: String,
    pub column: Layout,
}

/// One rendered block, delivered to the main thread as soon as it is ready.
#[derive(Debug)]
pub struct Completed {
    pub id: u64,
    pub text: String,
    pub column: Layout,
    pub result: Result<Raster>,
}

#[derive(Default)]
struct Pending {
    jobs: Option<Vec<Job>>,
    stopped: bool,
}

pub struct Worker {
    pending: Arc<(Mutex<Pending>, Condvar)>,
    child: Child,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    pub fn new(deliver: Arc<dyn Fn(Completed) + Send + Sync>) -> Result<Self> {
        let mut child = Command::new(std::env::var_os("MOZI_WORDCRAFT_BIN").unwrap_or_else(|| "wordcraft-cli".into()))
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("start wordcraft-cli: {e}"))?;
        let input = child.stdin.take().ok_or("wordcraft-cli stdin unavailable")?;
        let output = child.stdout.take().ok_or("wordcraft-cli stdout unavailable")?;
        let pending = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let queue = pending.clone();
        let thread = thread::spawn(move || {
            let mut client = Client { input, output: BufReader::new(output), id: 0 };
            let initialized = client.initialize();
            let (lock, wake) = &*queue;
            loop {
                let jobs = {
                    let mut state = lock.lock().unwrap();
                    while state.jobs.is_none() && !state.stopped {
                        state = wake.wait(state).unwrap();
                    }
                    if state.stopped {
                        break;
                    }
                    state.jobs.take().unwrap()
                };
                for job in jobs {
                    // A newer list supersedes the rest of this one; it re-lists anything still stale.
                    if lock.lock().map(|s| s.jobs.is_some() || s.stopped).unwrap_or(true) {
                        break;
                    }
                    let result = initialized.clone().and_then(|_| client.render(&job.text, job.column));
                    deliver(Completed { id: job.id, text: job.text, column: job.column, result });
                }
            }
        });
        Ok(Self { pending, child, thread: Some(thread) })
    }

    pub fn submit(&self, jobs: Vec<Job>) {
        self.pending.0.lock().unwrap().jobs = Some(jobs);
        self.pending.1.notify_one();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.pending.0.lock().unwrap().stopped = true;
        self.pending.1.notify_one();
        // Unblock a worker reading the process pipe before joining it.
        let _ = self.child.kill();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = self.child.wait();
    }
}

struct Client {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    id: u64,
}

impl Client {
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        writeln!(self.input, "{}", json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params})).map_err(|e| e.to_string())?;
        self.input.flush().map_err(|e| e.to_string())?;
        loop {
            let mut line = String::new();
            if self.output.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("wordcraft-cli closed stdout".into());
            }
            let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if value["id"].as_u64() != Some(self.id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(error.to_string());
            }
            return Ok(value["result"].clone());
        }
    }

    fn initialize(&mut self) -> Result<()> {
        let info = self.rpc("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mozi-particles","version":"0.1"}}))?;
        eprintln!("[mozi-particles] Wordcraft {}", info["serverInfo"]["version"]);
        writeln!(self.input, "{}", json!({"jsonrpc":"2.0","method":"notifications/initialized"})).map_err(|e| e.to_string())?;
        self.input.flush().map_err(|e| e.to_string())
    }

    fn tool(&mut self, name: &str, arguments: Value) -> Result<Value> {
        let result = self.rpc("tools/call", json!({"name":name,"arguments":arguments}))?;
        if result["isError"].as_bool() == Some(true) {
            return Err(result.to_string());
        }
        Ok(result)
    }

    fn render(&mut self, text: &str, layout: Layout) -> Result<Raster> {
        let orientation = if layout.width >= layout.height { "landscape" } else { "portrait" };
        for (command, params) in [
            ("file.open", json!({"path":"projection.md","data":STANDARD.encode(text)})),
            ("layout.size", json!({"width":layout.width,"height":layout.height})),
            ("layout.orientation", json!({"value":orientation})),
            ("layout.margins", json!({"top":MARKDOWN_MARGIN,"bottom":MARKDOWN_MARGIN,"left":MARKDOWN_MARGIN,"right":MARKDOWN_MARGIN})),
        ] {
            self.tool("execute", json!({"command":command,"params":params}))?;
        }
        let (first, pages) = self.page_image(1)?;
        let page_height = first.height();
        let (image, source_y) = if pages > 1 {
            // Oversized blocks show the newest viewport of ink. No navigation/history state.
            let previous = if pages == 2 { first } else { self.page_image(pages - 1)?.0 };
            let last = self.page_image(pages)?.0;
            let mut joined = image::RgbImage::from_pixel(last.width(), page_height * 2, image::Rgb([255; 3]));
            image::imageops::replace(&mut joined, &previous, 0, 0);
            image::imageops::replace(&mut joined, &last, 0, page_height as i64);
            (joined, (pages as u32 - 2) * page_height)
        } else {
            (first, 0)
        };
        let end = image
            .enumerate_pixels()
            .filter(|(_, _, p)| p.0.iter().any(|c| *c < 225))
            .map(|(_, y, _)| y + 1)
            .max()
            .unwrap_or(1);
        let end = (end + 4).min(image.height());
        let start = end.saturating_sub(page_height);
        Ok(Raster {
            image: image::imageops::crop_imm(&image, 0, start, image.width(), end - start).to_image(),
            source_y: source_y + start,
        })
    }

    fn page_image(&mut self, page: usize) -> Result<(image::RgbImage, usize)> {
        let result = self.tool("render_page", json!({"page":page,"scale":MARKDOWN_SCALE}))?;
        let blocks = result["content"].as_array().ok_or("missing Wordcraft content")?;
        let data = blocks
            .iter()
            .find(|b| b["type"] == "image")
            .and_then(|b| b["data"].as_str())
            .ok_or("missing Wordcraft PNG")?;
        let info: Value = serde_json::from_str(
            blocks
                .iter()
                .find(|b| b["type"] == "text")
                .and_then(|b| b["text"].as_str())
                .ok_or("missing Wordcraft dimensions")?,
        )
        .map_err(|e| e.to_string())?;
        let pages = info["pages"].as_u64().ok_or("invalid Wordcraft dimensions")? as usize;
        let png = STANDARD.decode(data).map_err(|e| e.to_string())?;
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?
            .to_rgb8();
        Ok((image, pages))
    }
}
