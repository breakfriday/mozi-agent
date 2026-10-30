//! Wallpaper source: system wallpaper detection, file loading and the procedural fallback.

use image::RgbaImage;
use std::path::{Path, PathBuf};

/// Auto-detects the Ubuntu GNOME desktop wallpaper via gsettings if available.
pub fn detect_gnome_wallpaper() -> Option<PathBuf> {
    for key in ["picture-uri-dark", "picture-uri"] {
        let output = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.background", key])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        let trimmed = raw.trim().trim_matches('\'').trim_matches('"');
        let path_str = trimmed.strip_prefix("file://").unwrap_or(trimmed);
        if !path_str.is_empty() {
            let path = PathBuf::from(path_str);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// Explicit path first, then the system wallpaper, then the procedural landscape.
pub fn load(path: Option<&Path>) -> RgbaImage {
    let resolved = path.map(Path::to_path_buf).or_else(detect_gnome_wallpaper);
    if let Some(p) = resolved {
        if let Ok(img) = image::open(&p) {
            return img.to_rgba8();
        }
    }
    create_landscape(640, 400)
}

/// Procedural nocturnal mountain-lake wallpaper fallback.
pub fn create_landscape(width: u32, height: u32) -> RgbaImage {
    let mut img = RgbaImage::new(width, height);
    for y in 0..height {
        let ny = y as f32 / (height.max(1) - 1) as f32;
        for x in 0..width {
            let nx = x as f32 / (width.max(1) - 1) as f32;
            let (mut r, mut g, mut b) = if ny < 0.62 {
                let t = ny / 0.62;
                (0.02 + t * 0.08, 0.05 + t * 0.16, 0.09 + t * 0.23)
            } else {
                let t = (ny - 0.62) / 0.38;
                (0.05 * (1.0 - t * 0.5), 0.15 * (1.0 - t * 0.45), 0.22 * (1.0 - t * 0.4))
            };
            // Moon glow around (0.72, 0.24)
            let dx = (nx - 0.72) * 1.6;
            let dy = ny - 0.24;
            let moon = (-(dx * dx + dy * dy).sqrt() * 7.5).exp();
            r += moon * 0.92;
            g += moon * 0.88;
            b += moon * 0.72;
            // Layered mountain ridges
            let ridge1 = 0.43 + (nx * 5.2).sin() * 0.06 + (nx * 13.0).cos() * 0.025;
            let ridge2 = 0.53 + (nx * 4.1 + 1.2).sin() * 0.055 + (nx * 9.7).sin() * 0.02;
            if ny > ridge1 && ny < 0.63 {
                r *= 0.42;
                g *= 0.48;
                b *= 0.56;
            }
            if ny > ridge2 && ny < 0.63 {
                r *= 0.35;
                g *= 0.38;
                b *= 0.45;
            }
            // Lake reflection ripples
            if ny >= 0.63 {
                let ref_dx = (nx - 0.72).abs();
                let shimmer = (-ref_dx * 14.0).exp() * ((ny * 95.0 + nx * 18.0).sin() * 0.5 + 0.5);
                r += shimmer * 0.45;
                g += shimmer * 0.48;
                b += shimmer * 0.38;
            }
            let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0) as u8;
            img.put_pixel(x, y, image::Rgba([c(r), c(g), c(b), 255]));
        }
    }
    img
}
