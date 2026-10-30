//! Terse GLYPH presets: 9 assembly/dispersal moves, 6 field dances, 8 named styles.
use crate::render_config;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum GlyphMove {
    Burst = 0,   // 四方飞聚/炸散
    Above = 1,   // 星陨：从上方落下 / 往上方升腾
    Vortex = 2,  // 星涡：绕字心螺旋旋进/旋出
    Side = 3,    // 打字机：从一侧横向扫入/扫出
    Diffuse = 4, // 水墨：原地柔和显影/晕开
    Ring = 5,    // 星环：从大环上收拢 / 摊回环上
    Shatter = 6, // 花火：沿字心放射崩裂
    Drift = 7,   // 极光：整句随风流走
    Below = 8,   // 静水：从下方浮起 / 往下方沉落
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum DanceMode {
    Vortex = 0,  // 旋流绕字心旋转
    Breathe = 1, // 径向呼吸潮汐
    Wave = 2,    // 正弦长波漫游
    Fall = 3,    // 纵向流瀑
    Shimmer = 4, // 原地星芒闪烁
    Drift = 5,   // 方向性斜向漂流
}

#[derive(Debug, Clone, Copy)]
pub struct ParticleStyle {
    pub id: &'static str,
    /// Display metadata for settings UIs; the engine itself only keys on `id`.
    #[allow(dead_code)]
    pub name: &'static str,
    #[allow(dead_code)]
    pub desc: &'static str,
    pub in_modes: &'static [GlyphMove],
    pub out_modes: &'static [GlyphMove],
    pub dances: &'static [DanceMode],
    pub swirl: f32,
    pub disp_fade: f32,
    pub bloom_size: f32,
    pub pulse_alpha: f32,
}

const ALL_IN_MODES: &[GlyphMove] = &[
    GlyphMove::Burst,
    GlyphMove::Above,
    GlyphMove::Vortex,
    GlyphMove::Side,
    GlyphMove::Diffuse,
    GlyphMove::Ring,
    GlyphMove::Shatter,
    GlyphMove::Drift,
    GlyphMove::Below,
];

const ALL_OUT_MODES: &[GlyphMove] = &[
    GlyphMove::Burst,
    GlyphMove::Shatter,
    GlyphMove::Drift,
    GlyphMove::Vortex,
    GlyphMove::Diffuse,
    GlyphMove::Above,
    GlyphMove::Below,
    GlyphMove::Ring,
    GlyphMove::Side,
];

const ALL_DANCES: &[DanceMode] = &[
    DanceMode::Vortex,
    DanceMode::Breathe,
    DanceMode::Wave,
    DanceMode::Fall,
    DanceMode::Shimmer,
    DanceMode::Drift,
];

pub const PARTICLE_STYLES: &[ParticleStyle] = &[
    ParticleStyle {
        id: "auto",
        name: "万象 · 流转",
        desc: "每次事件从 9 种聚散与 6 种律动中无重复抽取",
        in_modes: ALL_IN_MODES,
        out_modes: ALL_OUT_MODES,
        dances: ALL_DANCES,
        swirl: 1.5,
        disp_fade: 0.25,
        bloom_size: render_config::AUTO_GLYPH_HALO_SCALE,
        pulse_alpha: 0.85,
    },
    ParticleStyle {
        id: "meteor",
        name: "星陨 · 流光",
        desc: "字从天际坠落成形，散作星雨坠入深空",
        in_modes: &[GlyphMove::Above],
        out_modes: &[GlyphMove::Below, GlyphMove::Drift],
        dances: &[DanceMode::Fall],
        swirl: 0.7,
        disp_fade: 0.35,
        bloom_size: render_config::METEOR_GLYPH_HALO_SCALE,
        pulse_alpha: 0.9,
    },
    ParticleStyle {
        id: "firework",
        name: "花火 · 绽放",
        desc: "四方疾聚成字，停留后向四周绚烂崩裂",
        in_modes: &[GlyphMove::Burst],
        out_modes: &[GlyphMove::Shatter],
        dances: &[DanceMode::Shimmer],
        swirl: 1.4,
        disp_fade: 0.15,
        bloom_size: render_config::FIREWORK_GLYPH_HALO_SCALE,
        pulse_alpha: 0.95,
    },
    ParticleStyle {
        id: "ink",
        name: "水墨 · 氤氲",
        desc: "原地柔和显影，如墨滴入水般缓缓化开",
        in_modes: &[GlyphMove::Diffuse],
        out_modes: &[GlyphMove::Diffuse],
        dances: &[DanceMode::Breathe],
        swirl: 0.6,
        disp_fade: 0.85,
        bloom_size: render_config::INK_GLYPH_HALO_SCALE,
        pulse_alpha: 0.65,
    },
    ParticleStyle {
        id: "vortex",
        name: "星涡 · 坍缩",
        desc: "绕字心强旋卷入，再随旋臂甩向深空",
        in_modes: &[GlyphMove::Vortex],
        out_modes: &[GlyphMove::Vortex],
        dances: &[DanceMode::Vortex],
        swirl: 3.1,
        disp_fade: 0.2,
        bloom_size: render_config::VORTEX_GLYPH_HALO_SCALE,
        pulse_alpha: 0.9,
    },
    ParticleStyle {
        id: "aurora",
        name: "极光 · 漫游",
        desc: "字随极光长波横掠而入，化作流风远去",
        in_modes: &[GlyphMove::Side, GlyphMove::Drift],
        out_modes: &[GlyphMove::Drift],
        dances: &[DanceMode::Wave],
        swirl: 0.9,
        disp_fade: 0.45,
        bloom_size: render_config::AURORA_GLYPH_HALO_SCALE,
        pulse_alpha: 1.0,
    },
    ParticleStyle {
        id: "ring",
        name: "星环 · 潮汐",
        desc: "从环形星冕收束成句，散回大环脉动",
        in_modes: &[GlyphMove::Ring],
        out_modes: &[GlyphMove::Ring],
        dances: &[DanceMode::Breathe, DanceMode::Vortex],
        swirl: 2.0,
        disp_fade: 0.25,
        bloom_size: render_config::RING_GLYPH_HALO_SCALE,
        pulse_alpha: 0.85,
    },
    ParticleStyle {
        id: "still",
        name: "静水 · 浮沉",
        desc: "从深水静静浮起，停留一拍后沉入湖底",
        in_modes: &[GlyphMove::Below],
        out_modes: &[GlyphMove::Below],
        dances: &[DanceMode::Wave, DanceMode::Breathe],
        swirl: 0.5,
        disp_fade: 0.6,
        bloom_size: render_config::STILL_GLYPH_HALO_SCALE,
        pulse_alpha: 0.7,
    },
];

pub fn find_style(id: &str) -> &'static ParticleStyle {
    PARTICLE_STYLES.iter().find(|s| s.id == id).unwrap_or(&PARTICLE_STYLES[0])
}
