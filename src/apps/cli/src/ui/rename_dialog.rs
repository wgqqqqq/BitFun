/// Rename dialog for renaming the current session
///
/// A compact input overlay that allows the user to type a new session name.
/// Renders as a centered input box over the messages area.
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::ui::theme::{StyleKind, Theme};

/// Action returned by the rename dialog
#[derive(Debug, Clone)]
pub enum RenameAction {
    /// No action, dialog consumed the key
    None,
    /// User confirmed the new name
    Confirm(String),
    /// User cancelled the rename
    Cancel,
}

/// Rename dialog state
pub struct RenameDialogState {
    visible: bool,
    /// Text buffer for the new name
    buffer: String,
    /// Cursor position (in chars)
    cursor: usize,
}

impl RenameDialogState {
    pub fn new() -> Self {
        Self {
            visible: false,
            buffer: String::new(),
            cursor: 0,
        }
    }

    /// Show the dialog pre-filled with the current session name
    pub fn show(&mut self, current_name: &str) {
        self.buffer = current_name.to_string();
        self.cursor = self.buffer.chars().count();
        self.visible = true;
    }

    pub fn hide(&mut self) {
        self.visible = false;
        // Note: we don't clear buffer here to support back navigation
    }

    /// Reshow the rename dialog (for back navigation)
    pub fn reshow(&mut self) {
        self.visible = true;
    }

    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Handle a key event, returning what action to take
    pub fn handle_key_event(&mut self, key: KeyEvent) -> RenameAction {
        if !self.visible {
            return RenameAction::None;
        }

        match key.code {
            KeyCode::Enter => {
                let name = self.buffer.trim().to_string();
                self.hide();
                if name.is_empty() {
                    RenameAction::Cancel
                } else {
                    RenameAction::Confirm(name)
                }
            }
            KeyCode::Esc => {
                self.hide();
                RenameAction::Cancel
            }
            KeyCode::Char(c) => {
                let byte_pos = self.char_to_byte(self.cursor);
                self.buffer.insert(byte_pos, c);
                self.cursor += 1;
                RenameAction::None
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    let byte_pos = self.char_to_byte(self.cursor);
                    let next_byte = self.char_to_byte(self.cursor + 1);
                    self.buffer.replace_range(byte_pos..next_byte, "");
                }
                RenameAction::None
            }
            KeyCode::Left => {
                self.cursor = self.cursor.saturating_sub(1);
                RenameAction::None
            }
            KeyCode::Right => {
                let max = self.buffer.chars().count();
                self.cursor = (self.cursor + 1).min(max);
                RenameAction::None
            }
            KeyCode::Home => {
                self.cursor = 0;
                RenameAction::None
            }
            KeyCode::End => {
                self.cursor = self.buffer.chars().count();
                RenameAction::None
            }
            _ => RenameAction::None,
        }
    }

    /// Render the rename dialog as a centered overlay
    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if !self.visible {
            return;
        }

        // Dialog dimensions: a compact box with title, input line, and hint
        let dialog_width = area.width.saturating_sub(8).min(50);
        let dialog_height: u16 = 5; // border(1) + label(1) + input(1) + hint(1) + border(1)
        if dialog_width < 20 || area.height < dialog_height + 2 {
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
            .title(" Rename Session ");

        let inner = block.inner(dialog_area);
        frame.render_widget(block, dialog_area);

        if inner.height < 3 || inner.width < 10 {
            return;
        }

        // Row 0: label
        let label_area = Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: 1,
        };
        let label = Paragraph::new(Line::from(Span::styled(
            "Enter new session name:",
            theme.style(StyleKind::Info),
        )));
        frame.render_widget(label, label_area);

        // Row 1: input field with cursor
        let input_area = Rect {
            x: inner.x,
            y: inner.y + 1,
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

        // Row 2: hint
        let hint_area = Rect {
            x: inner.x,
            y: inner.y + 2,
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
