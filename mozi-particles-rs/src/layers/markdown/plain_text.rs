//! Plain-string projection (user messages, tool activity): local ab_glyph layout, no Wordcraft,
//! no Markdown parsing — `# 标题` or `*重点*` render exactly as typed.
//! Output follows the Wordcraft raster convention (dark ink on white paper, `MARKDOWN_SCALE` px/pt)
//! so the board samples both renderers identically.
use ab_glyph::{point, Font, FontArc, GlyphId, PxScale, ScaleFont};
use image::{Rgb, RgbImage};

use super::board::{Layout, Raster};
use crate::protocol::ProjectionRole;
use crate::render_config::*;

pub struct PlainTextRenderer {
    font: Option<FontArc>,
}

struct Line {
    chars: Vec<char>,
    width: f32,
}

impl PlainTextRenderer {
    pub fn new(font: Option<FontArc>) -> Self {
        Self { font }
    }

    fn font_size_pt(text: &str, role: &ProjectionRole) -> f32 {
        match role {
            ProjectionRole::User if text.chars().count() <= PROJECTION_USER_SHORT_CHARS => PROJECTION_USER_SHORT_FONT_PT,
            ProjectionRole::User => PROJECTION_USER_LONG_FONT_PT,
            _ => PROJECTION_ACTIVITY_FONT_PT,
        }
    }

    pub fn render(&self, text: &str, role: &ProjectionRole, column: Layout) -> Result<Raster, String> {
        let font = self.font.as_ref().ok_or("no system font available for plain-text projection")?;
        let em = Self::font_size_pt(text, role) * MARKDOWN_SCALE;
        let scale = PxScale::from(em * font.height_unscaled() / font.units_per_em().unwrap_or(1000.0));
        let scaled = font.as_scaled(scale);

        let width = (column.width as f32 * MARKDOWN_SCALE).round().max(1.0) as u32;
        let page_height = (column.height as f32 * MARKDOWN_SCALE).round().max(1.0) as u32;
        let margin = MARKDOWN_MARGIN * MARKDOWN_SCALE;
        let line_height = em * PLAIN_TEXT_LINE_HEIGHT;
        let lines = wrap(&scaled, text, (width as f32 - margin * 2.0).max(em));

        // Like Wordcraft's oversized blocks: keep only the newest lines that fit one page.
        let fit = (((page_height as f32 - margin * 2.0) / line_height).floor() as usize).max(1);
        let skipped = lines.len().saturating_sub(fit);
        let visible = &lines[skipped..];
        let height = ((visible.len() as f32 * line_height + margin * 2.0).ceil() as u32).clamp(1, page_height.max(1));

        let mut image = RgbImage::from_pixel(width, height, Rgb([255; 3]));
        let right = *role == ProjectionRole::User;
        let text_height = scaled.ascent() - scaled.descent();
        for (row, line) in visible.iter().enumerate() {
            let x0 = if right { width as f32 - margin - line.width } else { margin };
            let baseline = margin + row as f32 * line_height + (line_height - text_height) * 0.5 + scaled.ascent();
            let mut caret = x0;
            let mut prev: Option<GlyphId> = None;
            for &ch in &line.chars {
                let id = scaled.glyph_id(ch);
                if let Some(p) = prev {
                    caret += scaled.kern(p, id);
                }
                let glyph = id.with_scale_and_position(scale, point(caret, baseline));
                caret += scaled.h_advance(id);
                prev = Some(id);
                let Some(outlined) = font.outline_glyph(glyph) else { continue };
                let bounds = outlined.px_bounds();
                outlined.draw(|gx, gy, coverage| {
                    let x = bounds.min.x as i32 + gx as i32;
                    let y = bounds.min.y as i32 + gy as i32;
                    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                        return;
                    }
                    let ink = (255.0 * (1.0 - coverage.clamp(0.0, 1.0))) as u8;
                    let pixel = image.get_pixel_mut(x as u32, y as u32);
                    pixel.0 = pixel.0.map(|v| v.min(ink));
                });
            }
        }
        Ok(Raster { image, source_y: (skipped as f32 * line_height).round() as u32 })
    }
}

fn advance<F: Font, S: ScaleFont<F>>(scaled: &S, prev: Option<GlyphId>, ch: char) -> (GlyphId, f32) {
    let id = scaled.glyph_id(ch);
    let kern = prev.map_or(0.0, |p| scaled.kern(p, id));
    (id, scaled.h_advance(id) + kern)
}

fn measure<F: Font, S: ScaleFont<F>>(scaled: &S, chars: &[char]) -> (f32, Option<GlyphId>) {
    let mut prev = None;
    let mut width = 0.0;
    for &ch in chars {
        let (id, adv) = advance(scaled, prev, ch);
        width += adv;
        prev = Some(id);
    }
    (width, prev)
}

/// Greedy wrap: break at the last space for Latin words, anywhere for CJK. Explicit newlines kept.
fn wrap<F: Font, S: ScaleFont<F>>(scaled: &S, text: &str, max_width: f32) -> Vec<Line> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line: Vec<char> = Vec::new();
        let mut width = 0.0;
        let mut prev: Option<GlyphId> = None;
        let mut last_space: Option<usize> = None;
        for ch in paragraph.chars() {
            let ch = match ch {
                '\r' => continue,
                '\t' => ' ',
                c => c,
            };
            let (mut id, mut adv) = advance(scaled, prev, ch);
            if width + adv > max_width && !line.is_empty() {
                match last_space.filter(|&s| s > 0) {
                    Some(space) => {
                        let rest = line.split_off(space + 1);
                        line.pop(); // trailing space
                        let (w, _) = measure(scaled, &line);
                        lines.push(Line { chars: std::mem::take(&mut line), width: w });
                        line = rest;
                    }
                    None => {
                        lines.push(Line { chars: std::mem::take(&mut line), width });
                    }
                }
                last_space = None;
                let (w, p) = measure(scaled, &line);
                width = w;
                prev = p;
                (id, adv) = advance(scaled, prev, ch);
            }
            if ch == ' ' {
                last_space = Some(line.len());
            }
            line.push(ch);
            width += adv;
            prev = Some(id);
        }
        lines.push(Line { chars: line, width });
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::glyph::load_system_font;

    fn renderer() -> Option<PlainTextRenderer> {
        load_system_font().map(|f| PlainTextRenderer::new(Some(f)))
    }

    fn ink_columns(raster: &Raster) -> (u32, u32) {
        let xs: Vec<u32> = raster.image.enumerate_pixels().filter(|(_, _, p)| p.0[0] < 128).map(|(x, _, _)| x).collect();
        (*xs.iter().min().unwrap(), *xs.iter().max().unwrap())
    }

    #[test]
    fn user_text_is_right_aligned_and_activity_left_aligned() {
        let Some(r) = renderer() else { return };
        let column = Layout { width: 300, height: 400 };
        let user = r.render("你好 hello", &ProjectionRole::User, column).unwrap();
        let activity = r.render("执行 bash", &ProjectionRole::Activity, column).unwrap();
        let margin = (MARKDOWN_MARGIN * MARKDOWN_SCALE) as u32;
        assert!(ink_columns(&user).1 >= user.image.width() - margin - 4);
        assert!(ink_columns(&activity).0 <= margin + 4);
    }

    #[test]
    fn long_text_wraps_and_keeps_newest_viewport() {
        let Some(r) = renderer() else { return };
        let column = Layout { width: 160, height: 120 };
        let short = r.render("短", &ProjectionRole::User, column).unwrap();
        let long = r.render(&"很长的用户输入需要换行显示。".repeat(40), &ProjectionRole::User, column).unwrap();
        assert!(long.image.height() > short.image.height());
        assert!(long.image.height() <= (column.height as f32 * MARKDOWN_SCALE).round() as u32);
        assert!(long.source_y > 0, "oldest lines scrolled away");
    }

    #[test]
    fn markdown_syntax_is_not_interpreted() {
        let Some(r) = renderer() else { return };
        let column = Layout { width: 300, height: 400 };
        let heading = r.render("# 标题", &ProjectionRole::User, column).unwrap();
        let plain = r.render("标题", &ProjectionRole::User, column).unwrap();
        // Same font size (both short) and the '#' adds visible ink on the left.
        assert_eq!(heading.image.height(), plain.image.height());
        assert!(ink_columns(&heading).0 < ink_columns(&plain).0);
    }
}
