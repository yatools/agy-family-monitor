// Adapted from CC Switch, MIT, Copyright (c) 2025 Jason Young.
// See THIRD_PARTY_NOTICES.md and licenses/CC-Switch-MIT.txt.

pub fn model_from_settings_change(content: &str) -> Option<String> {
    let start = content.find("Model Selection")?;
    let rest = &content[start..];
    let to = rest.find(" to ")? + 4;
    let tail = &rest[to..];
    let end = tail
        .find(". ")
        .or_else(|| tail.find('\n'))
        .or_else(|| tail.find('`'))
        .unwrap_or(tail.len());
    let model = tail[..end].trim().trim_matches('.').trim();
    if model.is_empty() || model.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(model.to_string())
    }
}

pub fn model_id_of(display: &str) -> String {
    if !display.contains(' ') {
        return display.to_string();
    }
    display
        .to_ascii_lowercase()
        .replace(" (", "-")
        .replace(['(', ')'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

pub fn known_model(model: Option<&str>) -> Option<&str> {
    model.filter(|model| !model.trim().is_empty() && !model.eq_ignore_ascii_case("unknown"))
}
