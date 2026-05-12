/// Workspace dialog for switching the current workspace directory
///
/// A compact input overlay that allows the user to type a new workspace path.
/// Renders as a centered input box over the messages area.
/// Shows the current workspace path and validates the new path exists.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::ui::theme::{StyleKind, Theme};

/// Action returned by the workspace dialog
#[derive(Debug, Clone)]
pub enum WorkspaceAction {
    /// No action, dialog consumed the key
    None,
    /// User confirmed the new workspace path
    Confirm(String),
    /// User cancelled the dialog
    Cancel,
}

/// Workspace dialog state
pub struct WorkspaceDialogState {
    visible: bool,
    /// Text buffer for the workspace path
    buffer: String,
    /// Cursor position (in chars)
    cursor: usize,
    /// Current workspace path (shown as reference)
    current_workspace: String,
    /// Validation error message (shown when path is invalid)
    error: Option<String>,
}

impl WorkspaceDialogState {
    pub fn new() -> Self {
        Self {
            visible: false,
            buffer: String::new(),
            cursor: 0,
            current_workspace: String::new(),
            error: None,
        }
    }

    /// Show the dialog with the current workspace path as reference
    pub fn show(&mut self, current_workspace: &str) {
        self.current_workspace = current_workspace.to_string();
        self.buffer = current_workspace.to_string();
        self.cursor = self.buffer.chars().count();
        self.error = None;
        self.visible = true;
    }

    pub fn hide(&mut self) {
        self.visible = false;
        // Note: we don't clear buffer here to support back navigation
    }

    /// Reshow the workspace dialog (for back navigation)
    pub fn reshow(&mut self) {
        self.visible = true;
    }

    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Handle a key event, returning what action to take
    pub fn handle_key_event(&mut self, key: KeyEvent) -> WorkspaceAction {
        if !self.visible {
            return WorkspaceAction::None;
        }

        match key.code {
            KeyCode::Enter => {
                let path = self.buffer.trim().to_string();
                if path.is_empty() {
                    self.hide();
                    return WorkspaceAction::Cancel;
                }

                // Validate the path exists and is a directory
                let resolved = if path == "." {
                    std::env::current_dir()
                        .ok()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or(path.clone())
                } else {
                    path.clone()
                };

                let path_buf = std::path::PathBuf::from(&resolved);
                if !path_buf.exists() {
                    self.error = Some(format!("Path does not exist: {}", resolved));
                    return WorkspaceAction::None;
                }
                if !path_buf.is_dir() {
                    self.error = Some(format!("Not a directory: {}", resolved));
                    return WorkspaceAction::None;
                }

                // Canonicalize the path
                let canonical = dunce::canonicalize(&path_buf)
                    .unwrap_or(path_buf)
                    .to_string_lossy()
                    .to_string();

                self.hide();
                WorkspaceAction::Confirm(canonical)
            }
            KeyCode::Esc => {
                self.hide();
                WorkspaceAction::Cancel
            }
            KeyCode::Char(c) => {
                self.error = None;
                let byte_pos = self.char_to_byte(self.cursor);
                self.buffer.insert(byte_pos, c);
                self.cursor += 1;
                WorkspaceAction::None
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.error = None;
                    self.cursor -= 1;
                    let byte_pos = self.char_to_byte(self.cursor);
                    let next_byte = self.char_to_byte(self.cursor + 1);
                    self.buffer.replace_range(byte_pos..next_byte, "");
                }
                WorkspaceAction::None
            }
            KeyCode::Left => {
                self.cursor = self.cursor.saturating_sub(1);
                WorkspaceAction::None
            }
            KeyCode::Right => {
                let max = self.buffer.chars().count();
                self.cursor = (self.cursor + 1).min(max);
                WorkspaceAction::None
            }
            KeyCode::Home => {
                self.cursor = 0;
                WorkspaceAction::None
            }
            KeyCode::End => {
                self.cursor = self.buffer.chars().count();
                WorkspaceAction::None
            }
            _ => WorkspaceAction::None,
        }
    }

    /// Render the workspace dialog as a centered overlay
    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if !self.visible {
            return;
        }

        // Dialog dimensions: wider than rename dialog to accommodate paths
        let dialog_width = area.width.saturating_sub(4).min(80);
        let has_error = self.error.is_some();
        let dialog_height: u16 = if has_error { 7 } else { 6 };
        // border(1) + current(1) + label(1) + input(1) + [error(1)] + hint(1) + border(1)
        if dialog_width < 30 || area.height < dialog_height + 2 {
            return;
        }

        let dialog_x = area.x + (area.width.saturating_sub(dialog_width)) / 2;
        let dialog_y = area.y + (area.height.saturating_sub(dialog_height)) / 2;

        let dialog_area = Rect {
            x: dialog_x,
            y: dialog_y,
            width: dialog_width,
            height: dialog_height,
        };

        // Clear background
        frame.render_widget(Clear, dialog_area);

        // Draw border
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(theme.style(StyleKind::Primary))
            .style(Style::default().bg(theme.background))
            .title(" Switch Workspace ");

        let inner = block.inner(dialog_area);
        frame.render_widget(block, dialog_area);

        if inner.height < 3 || inner.width < 10 {
            return;
        }

        let mut row = 0;

        // Row 0: current workspace
        let current_area = Rect {
            x: inner.x,
            y: inner.y + row,
            width: inner.width,
            height: 1,
        };
        let current_display = if self.current_workspace.is_empty() {
            "No workspace".to_string()
        } else {
            self.current_workspace.clone()
        };
        let current_line = Line::from(vec![
            Span::styled("Current: ", theme.style(StyleKind::Muted)),
            Span::styled(current_display, theme.style(StyleKind::Info)),
        ]);
        frame.render_widget(Paragraph::new(current_line), current_area);
        row += 1;

        // Row 1: label
        let label_area = Rect {
            x: inner.x,
            y: inner.y + row,
            width: inner.width,
            height: 1,
        };
        let label = Paragraph::new(Line::from(Span::styled(
            "Enter new workspace path:",
            theme.style(StyleKind::Info),
        )));
        frame.render_widget(label, label_area);
        row += 1;

        // Row 2: input field with cursor
        let input_area = Rect {
            x: inner.x,
            y: inner.y + row,
            width: inner.width,
            height: 1,
        };

        let cursor_byte = self.char_to_byte(self.cursor);
        let before_cursor = &self.buffer[..cursor_byte];
        let after_cursor = &self.buffer[cursor_byte..];

        let input_line = Line::from(vec![
            Span::styled(
                "> ",
                theme.style(StyleKind::Primary).add_modifier(Modifier::BOLD),
            ),
            Span::styled(before_cursor, Style::default().fg(Color::White)),
            Span::styled(
                if after_cursor.is_empty() {
                    " "
                } else {
                    &after_cursor[..after_cursor
                        .char_indices()
                        .nth(1)
                        .map(|(i, _)| i)
                        .unwrap_or(after_cursor.len())]
                },
                Style::default().fg(Color::Black).bg(Color::White),
            ),
            Span::styled(
                if after_cursor.is_empty() {
                    ""
                } else {
                    let first_char_end = after_cursor
                        .char_indices()
                        .nth(1)
                        .map(|(i, _)| i)
                        .unwrap_or(after_cursor.len());
                    &after_cursor[first_char_end..]
                },
                Style::default().fg(Color::White),
            ),
        ]);
        let input_widget = Paragraph::new(input_line);
        frame.render_widget(input_widget, input_area);
        row += 1;

        // Row 3 (optional): error message
        if let Some(ref error) = self.error {
            let error_area = Rect {
                x: inner.x,
                y: inner.y + row,
                width: inner.width,
                height: 1,
            };
            let error_line = Paragraph::new(Line::from(Span::styled(
                error.as_str(),
                Style::default().fg(Color::Red),
            )));
            frame.render_widget(error_line, error_area);
            row += 1;
        }

        // Last row: hint
        let hint_area = Rect {
            x: inner.x,
            y: inner.y + row,
            width: inner.width,
            height: 1,
        };
        let hint = Paragraph::new(Line::from(Span::styled(
            "Enter: Confirm  Esc: Cancel",
            theme.style(StyleKind::Muted),
        )));
        frame.render_widget(hint, hint_area);
    }

    fn char_to_byte(&self, char_pos: usize) -> usize {
        self.buffer
            .char_indices()
            .nth(char_pos)
            .map(|(i, _)| i)
            .unwrap_or(self.buffer.len())
    }
}
