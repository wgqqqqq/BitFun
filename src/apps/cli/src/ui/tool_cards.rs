/// Tool card rendering
use ratatui::{
    text::{Line, Span},
    widgets::ListItem,
};

use super::string_utils::{prettify_result, truncate_str};
use super::theme::{StyleKind, Theme};
use crate::session::ToolCall;

pub fn render_tool_card<'a>(tool_call: &'a ToolCall, theme: &Theme) -> Vec<ListItem<'a>> {
    let mut items = Vec::new();

    // Choose specialized renderer based on tool type
    match tool_call.tool_name.as_str() {
        "read_file" | "read_file_tool" => render_read_file_card(&mut items, tool_call, theme),
        "write_file" | "write_file_tool" | "search_replace" => {
            render_write_file_card(&mut items, tool_call, theme)
        }
        "bash_tool" | "run_terminal_cmd" => render_bash_tool_card(&mut items, tool_call, theme),
        "codebase_search" => render_codebase_search_card(&mut items, tool_call, theme),
        "grep" => render_grep_card(&mut items, tool_call, theme),
        "list_dir" | "ls" => render_list_dir_card(&mut items, tool_call, theme),
        _ => render_default_tool_card(&mut items, tool_call, theme),
    }

    items
}

fn render_read_file_card<'a>(
    items: &mut Vec<ListItem<'a>>,
    tool_call: &'a ToolCall,
    theme: &Theme,
) {
    use crate::session::ToolCallStatus;

    // Get file path
    let file_path = tool_call
        .parameters
        .get("file_path")
        .or_else(|| tool_call.parameters.get("target_file"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    // Status icon
    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running | ToolCallStatus::Streaming => {
            ("*", theme.style(StyleKind::Primary))
        }
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    // Top border
    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw("[Read] "),
        Span::styled("Read file", theme.style(StyleKind::Info)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    // File path
    items.push(ListItem::new(Line::from(vec![
        Span::raw("  │ "),
        Span::styled(file_path, theme.style(StyleKind::Primary)),
    ])));

    // Result (if available)
    if let Some(result) = &tool_call.result {
        let summary = truncate_str(result, 80);

        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(summary, theme.style(StyleKind::Muted)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Reading...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn render_write_file_card<'a>(
    items: &mut Vec<ListItem<'a>>,
    tool_call: &'a ToolCall,
    theme: &Theme,
) {
    use crate::session::ToolCallStatus;

    let file_path = tool_call
        .parameters
        .get("file_path")
        .or_else(|| tool_call.parameters.get("target_file"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running => ("*", theme.style(StyleKind::Primary)),
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw("[Edit] "),
        Span::styled("Edit file", theme.style(StyleKind::Warning)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  │ "),
        Span::styled(file_path, theme.style(StyleKind::Primary)),
    ])));

    if let Some(result) = &tool_call.result {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(result, theme.style(StyleKind::Success)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Modifying...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn render_bash_tool_card<'a>(
    items: &mut Vec<ListItem<'a>>,
    tool_call: &'a ToolCall,
    theme: &Theme,
) {
    use crate::session::ToolCallStatus;

    let command = tool_call
        .parameters
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running | ToolCallStatus::Streaming => {
            ("*", theme.style(StyleKind::Primary))
        }
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw("[Bash] "),
        Span::styled("Execute command", theme.style(StyleKind::Primary)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    // Command (limited length)
    let cmd_display = truncate_str(command, 60);

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  │ "),
        Span::styled(cmd_display, theme.style(StyleKind::Info)),
    ])));

    // Output summary
    if let Some(result) = &tool_call.result {
        let lines: Vec<&str> = result.lines().collect();
        let summary = if lines.len() > 1 {
            format!("{} ({} lines output)", lines[0], lines.len())
        } else {
            result.clone()
        };

        let summary_short = truncate_str(&summary, 80);

        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(summary_short, theme.style(StyleKind::Muted)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Executing...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn render_codebase_search_card<'a>(
    items: &mut Vec<ListItem<'a>>,
    tool_call: &'a ToolCall,
    theme: &Theme,
) {
    use crate::session::ToolCallStatus;

    let query = tool_call
        .parameters
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running => ("*", theme.style(StyleKind::Primary)),
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw("[Search] "),
        Span::styled("Code search", theme.style(StyleKind::Info)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  │ "),
        Span::styled(query, theme.style(StyleKind::Primary)),
    ])));

    if let Some(result) = &tool_call.result {
        // Try to parse result count
        let summary = if result.contains("chunk") {
            "Found relevant code snippets"
        } else {
            "Search complete"
        };

        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(summary, theme.style(StyleKind::Success)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Searching...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn render_grep_card<'a>(items: &mut Vec<ListItem<'a>>, tool_call: &'a ToolCall, theme: &Theme) {
    use crate::session::ToolCallStatus;

    let pattern = tool_call
        .parameters
        .get("pattern")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running => ("*", theme.style(StyleKind::Primary)),
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw("[Grep] "),
        Span::styled("Text search", theme.style(StyleKind::Info)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  │ "),
        Span::styled(pattern, theme.style(StyleKind::Primary)),
    ])));

    if let Some(result) = &tool_call.result {
        let lines_count = result.lines().count();
        let summary = format!("Found {} matches", lines_count);

        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(summary, theme.style(StyleKind::Success)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Searching...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn render_list_dir_card<'a>(items: &mut Vec<ListItem<'a>>, tool_call: &'a ToolCall, theme: &Theme) {
    use crate::session::ToolCallStatus;

    let path = tool_call
        .parameters
        .get("target_directory")
        .or_else(|| tool_call.parameters.get("path"))
        .and_then(|v| v.as_str())
        .unwrap_or(".");

    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running => ("*", theme.style(StyleKind::Primary)),
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw("[List] "),
        Span::styled("List directory", theme.style(StyleKind::Info)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  │ "),
        Span::styled(path, theme.style(StyleKind::Primary)),
    ])));

    if let Some(result) = &tool_call.result {
        let items_count = result.lines().count();
        let summary = format!("{} items", items_count);

        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(summary, theme.style(StyleKind::Success)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Reading...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn render_default_tool_card<'a>(
    items: &mut Vec<ListItem<'a>>,
    tool_call: &'a ToolCall,
    theme: &Theme,
) {
    use crate::session::ToolCallStatus;

    let (icon, _color) = crate::ui::theme::tool_icon(&tool_call.tool_name);

    let (status_icon, status_style) = match &tool_call.status {
        ToolCallStatus::Running | ToolCallStatus::Streaming => {
            ("*", theme.style(StyleKind::Primary))
        }
        ToolCallStatus::Success => ("+", theme.style(StyleKind::Success)),
        ToolCallStatus::Failed => ("x", theme.style(StyleKind::Error)),
        ToolCallStatus::Queued => ("||", theme.style(StyleKind::Muted)),
        ToolCallStatus::Waiting => ("...", theme.style(StyleKind::Warning)),
        _ => ("-", theme.style(StyleKind::Muted)),
    };

    items.push(ListItem::new(Line::from(vec![
        Span::raw("  ┌─ "),
        Span::raw(icon),
        Span::raw(" "),
        Span::styled(&tool_call.tool_name, theme.style(StyleKind::Primary)),
        Span::raw(" "),
        Span::styled(status_icon, status_style),
    ])));

    // Show parameter summary (only key fields)
    let param_summary = extract_key_params(&tool_call.parameters);
    if !param_summary.is_empty() {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  │ "),
            Span::styled(param_summary, theme.style(StyleKind::Info)),
        ])));
    }

    // Progress info
    if let Some(progress_msg) = &tool_call.progress_message {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  │ "),
            Span::styled(progress_msg, theme.style(StyleKind::Muted)),
        ])));
    }

    // Result
    if let Some(result) = &tool_call.result {
        let summary = prettify_result(result);

        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled(summary, theme.style(StyleKind::Muted)),
        ])));
    } else {
        items.push(ListItem::new(Line::from(vec![
            Span::raw("  └─ "),
            Span::styled("Executing...", theme.style(StyleKind::Muted)),
        ])));
    }
}

fn extract_key_params(params: &serde_json::Value) -> String {
    if let Some(obj) = params.as_object() {
        let priority_keys = [
            "path",
            "file_path",
            "target_file",
            "query",
            "pattern",
            "command",
            "message",
        ];

        for key in &priority_keys {
            if let Some(value) = obj.get(*key) {
                if let Some(s) = value.as_str() {
                    return s.to_string();
                }
            }
        }

        for (_key, value) in obj.iter() {
            if let Some(s) = value.as_str() {
                if s.len() < 100 {
                    return s.to_string();
                }
            }
        }
    }

    String::new()
}
