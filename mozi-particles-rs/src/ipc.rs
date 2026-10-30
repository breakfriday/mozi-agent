//! JSON Lines protocol over stdio, driven by the mozi-electron main process.
//!
//! stdin  (one JSON object per line):
//!   {"type":"notice","key":"s1:r1","text":"正在执行 · bash","tone":"activity"}
//!   {"type":"style","id":"firework"}
//!   {"type":"wallpaper","path":"/home/me/wall.jpg"}   // path omitted => system wallpaper
//!   {"type":"focus"}
//!   {"type":"quit"}
//! stdout:
//!   {"type":"ready"} | {"type":"closed"} | {"type":"error","message":"..."}
//!
//! EOF on stdin (parent exited or closed the pipe) terminates the engine.

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use winit::event_loop::EventLoopProxy;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Command {
    Project { content: Option<crate::scene::Projection> },
    Notice {
        #[serde(default)]
        key: Option<String>,
        text: String,
        #[serde(default)]
        tone: Option<String>,
    },
    Configure { style: String, paused: bool, cruise: bool, depth: f32 },
    Style {
        id: String,
    },
    Wallpaper {
        #[serde(default)]
        path: Option<String>,
    },
    Focus,
    Quit,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Reply<'a> {
    Ready,
    Closed,
    Error { message: &'a str },
}

#[derive(Debug)]
pub enum UserEvent {
    Markdown(crate::markdown::Completed),
    Command(Command),
    StdinClosed,
}

pub fn reply(message: Reply) {
    if let Ok(line) = serde_json::to_string(&message) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// Reads stdin on a dedicated thread and forwards parsed commands into the winit loop.
pub fn spawn_stdin_reader(proxy: EventLoopProxy<UserEvent>) {
    std::thread::Builder::new()
        .name("mozi-particles-stdin".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Command>(line) {
                    Ok(cmd) => {
                        if proxy.send_event(UserEvent::Command(cmd)).is_err() {
                            return;
                        }
                    }
                    Err(e) => reply(Reply::Error { message: &format!("invalid command: {e}") }),
                }
            }
            let _ = proxy.send_event(UserEvent::StdinClosed);
        })
        .expect("spawn stdin reader");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol() {
        let cmd: Command = serde_json::from_str(r#"{"type":"notice","key":"a","text":"hi","tone":"success"}"#).unwrap();
        assert!(matches!(cmd, Command::Notice { ref text, .. } if text == "hi"));
        let cmd: Command = serde_json::from_str(r#"{"type":"wallpaper"}"#).unwrap();
        assert!(matches!(cmd, Command::Wallpaper { path: None }));
        assert!(matches!(serde_json::from_str::<Command>(r#"{"type":"quit"}"#).unwrap(), Command::Quit));
        let cmd = serde_json::from_str::<Command>(r#"{"type":"configure","style":"ink","paused":true,"cruise":false,"depth":1.5}"#).unwrap();
        assert!(matches!(cmd, Command::Configure { paused: true, cruise: false, depth, .. } if depth == 1.5));
        assert_eq!(serde_json::to_string(&Reply::Ready).unwrap(), r#"{"type":"ready"}"#);
    }
}
