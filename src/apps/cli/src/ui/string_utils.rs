/// String processing utilities

/// Safely truncate string to specified byte length
pub fn truncate_str(s: &str, max_bytes: usize) -> String {
    let first_line = s.lines().next().unwrap_or("");

    if first_line.len() <= max_bytes {
        return first_line.to_string();
    }

    let mut boundary = max_bytes;
    while boundary > 0 && !first_line.is_char_boundary(boundary) {
        boundary -= 1;
    }

    if boundary == 0 {
        return String::new();
    }

    format!("{}...", &first_line[..boundary])
}

/// Prettify tool result display
pub fn prettify_result(s: &str) -> String {
    let first_line = s.lines().next().unwrap_or("");

    let looks_like_debug = first_line.contains("Some(")
        || first_line.contains(": None")
        || (first_line.matches('{').count() > 2)
        || first_line.contains("_tokens:");

    if looks_like_debug {
        if s.contains("Success") || s.contains("Ok") {
            return "✓ Execution successful".to_string();
        } else {
            return "Done".to_string();
        }
    }

    truncate_str(s, 80)
}
