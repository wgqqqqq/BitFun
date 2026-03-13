/// Markdown rendering utilities
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};

use super::theme::{StyleKind, Theme};

/// Markdown renderer
pub struct MarkdownRenderer {
    /// Theme
    theme: Theme,
}

impl MarkdownRenderer {
    pub fn new(theme: Theme) -> Self {
        Self { theme }
    }

    pub fn render(&self, markdown: &str, _width: usize) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        let mut current_line_spans: Vec<Span<'static>> = Vec::new();

        // Style stack
        let mut style_stack: Vec<StyleModifier> = Vec::new();
        let mut list_level: usize = 0;
        let mut in_code_block = false;
        let mut code_block_lang = String::new();

        let options = Options::all();
        let parser = Parser::new_ext(markdown, options);

        for event in parser {
            match event {
                Event::Start(tag) => {
                    match tag {
                        Tag::Heading { level, .. } => {
                            // Add empty line before heading
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                            lines.push(Line::from(""));

                            // Heading prefix
                            let prefix = match level {
                                HeadingLevel::H1 => "# ",
                                HeadingLevel::H2 => "## ",
                                HeadingLevel::H3 => "### ",
                                HeadingLevel::H4 => "#### ",
                                HeadingLevel::H5 => "##### ",
                                HeadingLevel::H6 => "###### ",
                            };
                            current_line_spans.push(Span::styled(
                                prefix.to_string(),
                                self.theme
                                    .style(StyleKind::Primary)
                                    .add_modifier(Modifier::BOLD),
                            ));

                            style_stack.push(StyleModifier::Heading);
                        }
                        Tag::Paragraph => {
                            // Paragraph doesn't need special handling, just ensure line break
                        }
                        Tag::BlockQuote(_) => {
                            current_line_spans.push(Span::styled(
                                "│ ".to_string(),
                                self.theme.style(StyleKind::Muted),
                            ));
                            style_stack.push(StyleModifier::Quote);
                        }
                        Tag::CodeBlock(kind) => {
                            in_code_block = true;
                            if let pulldown_cmark::CodeBlockKind::Fenced(lang) = kind {
                                code_block_lang = lang.to_string();
                            }
                            // Add empty line before code block
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                            lines.push(Line::from(""));

                            // Add language identifier
                            if !code_block_lang.is_empty() {
                                current_line_spans.push(Span::styled(
                                    format!("```{}", code_block_lang),
                                    self.theme.style(StyleKind::Muted),
                                ));
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                        }
                        Tag::List(_) => {
                            list_level += 1;
                            if list_level == 1 && !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                        }
                        Tag::Item => {
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                            // Add indentation and list marker
                            let indent = "  ".repeat(list_level.saturating_sub(1));
                            current_line_spans.push(Span::raw(indent));
                            current_line_spans.push(Span::styled(
                                "• ".to_string(),
                                self.theme.style(StyleKind::Primary),
                            ));
                        }
                        Tag::Strong => {
                            style_stack.push(StyleModifier::Bold);
                        }
                        Tag::Emphasis => {
                            style_stack.push(StyleModifier::Italic);
                        }
                        Tag::Link { .. } => {
                            style_stack.push(StyleModifier::Link);
                        }
                        Tag::Image { .. } => {
                            current_line_spans.push(Span::styled(
                                "[Image]".to_string(),
                                self.theme.style(StyleKind::Info),
                            ));
                        }
                        _ => {}
                    }
                }

                Event::End(tag_end) => {
                    match tag_end {
                        TagEnd::Heading(_) => {
                            if let Some(StyleModifier::Heading) = style_stack.last() {
                                style_stack.pop();
                            }
                            lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                        }
                        TagEnd::Paragraph => {
                            if !in_code_block && !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                                lines.push(Line::from("")); // Empty line after paragraph
                            }
                        }
                        TagEnd::BlockQuote => {
                            if let Some(StyleModifier::Quote) = style_stack.last() {
                                style_stack.pop();
                            }
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                        }
                        TagEnd::CodeBlock => {
                            in_code_block = false;
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                            // Code block end marker
                            if !code_block_lang.is_empty() {
                                lines.push(Line::from(Span::styled(
                                    "```".to_string(),
                                    self.theme.style(StyleKind::Muted),
                                )));
                                code_block_lang.clear();
                            }
                            lines.push(Line::from("")); // Empty line after code block
                        }
                        TagEnd::List(_) => {
                            list_level = list_level.saturating_sub(1);
                            if list_level == 0 && !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                                lines.push(Line::from("")); // Empty line after list
                            }
                        }
                        TagEnd::Item => {
                            // Line break when list item ends
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                        }
                        TagEnd::Strong => {
                            if let Some(StyleModifier::Bold) = style_stack.last() {
                                style_stack.pop();
                            }
                        }
                        TagEnd::Emphasis => {
                            if let Some(StyleModifier::Italic) = style_stack.last() {
                                style_stack.pop();
                            }
                        }
                        TagEnd::Link => {
                            if let Some(StyleModifier::Link) = style_stack.last() {
                                style_stack.pop();
                            }
                        }
                        _ => {}
                    }
                }

                Event::Text(text) => {
                    let style = self.compute_style(&style_stack, in_code_block);

                    if in_code_block {
                        // Code block: process each line separately
                        for line in text.lines() {
                            current_line_spans.push(Span::styled(format!("  {}", line), style));
                            lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                        }
                    } else {
                        // Normal text
                        current_line_spans.push(Span::styled(text.to_string(), style));
                    }
                }

                Event::Code(code) => {
                    // Inline code
                    current_line_spans.push(Span::styled(
                        format!("`{}`", code),
                        self.theme.style(StyleKind::Success),
                    ));
                }

                Event::SoftBreak | Event::HardBreak => {
                    if !in_code_block && !current_line_spans.is_empty() {
                        lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                    }
                }

                Event::Rule => {
                    lines.push(Line::from(Span::styled(
                        "─".repeat(60),
                        self.theme.style(StyleKind::Muted),
                    )));
                }

                _ => {}
            }
        }

        // Process remaining spans
        if !current_line_spans.is_empty() {
            lines.push(Line::from(current_line_spans));
        }

        // Remove trailing empty lines
        while lines.last().map_or(false, |line| {
            line.spans.is_empty() || (line.spans.len() == 1 && line.spans[0].content.is_empty())
        }) {
            lines.pop();
        }

        lines
    }

    fn compute_style(&self, stack: &[StyleModifier], in_code_block: bool) -> Style {
        let mut style = Style::default();

        if in_code_block {
            return self.theme.style(StyleKind::Success);
        }

        for modifier in stack {
            style = match modifier {
                StyleModifier::Bold => style.add_modifier(Modifier::BOLD),
                StyleModifier::Italic => style.add_modifier(Modifier::ITALIC),
                StyleModifier::Heading => self
                    .theme
                    .style(StyleKind::Primary)
                    .add_modifier(Modifier::BOLD),
                StyleModifier::Quote => style.fg(self.theme.muted),
                StyleModifier::Link => self
                    .theme
                    .style(StyleKind::Info)
                    .add_modifier(Modifier::UNDERLINED),
            };
        }

        style
    }

    pub fn has_markdown_syntax(text: &str) -> bool {
        text.contains("**")
            || text.contains("__")
            || text.contains("*")
            || text.contains("_")
            || text.contains("`")
            || text.contains("#")
            || text.contains("[")
            || text.contains(">")
            || text.contains("```")
    }
}

/// Style modifier
#[derive(Debug, Clone, Copy)]
enum StyleModifier {
    Bold,
    Italic,
    Heading,
    Quote,
    Link,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_has_markdown_syntax() {
        assert!(MarkdownRenderer::has_markdown_syntax("**bold**"));
        assert!(MarkdownRenderer::has_markdown_syntax("*italic*"));
        assert!(MarkdownRenderer::has_markdown_syntax("`code`"));
        assert!(MarkdownRenderer::has_markdown_syntax("# Title"));
        assert!(!MarkdownRenderer::has_markdown_syntax("plain text"));
    }

    #[test]
    fn test_render_simple() {
        let theme = Theme::default();
        let renderer = MarkdownRenderer::new(theme);
        let lines = renderer.render("**bold** text", 80);
        assert!(!lines.is_empty());
    }

    #[test]
    fn test_render_code_block() {
        let theme = Theme::default();
        let renderer = MarkdownRenderer::new(theme);
        let markdown = "```rust\nfn main() {\n    println!(\"Hello\");\n}\n```";
        let lines = renderer.render(markdown, 80);
        assert!(lines.len() > 3);
    }
}
