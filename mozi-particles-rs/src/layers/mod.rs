//! Self-contained visual layers. Each owns its CPU sampling, state and WGSL; they share only the
//! camera (via the frame uniform) and the `FocusSignal` text layers publish to the field.
pub mod field;
pub mod glyph;
pub mod markdown;
