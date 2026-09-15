const STATUS_GREEN: [u8; 4] = [74, 197, 145, 255];
const STATUS_RED: [u8; 4] = [199, 52, 73, 255];
const STATUS_DARK: [u8; 4] = [22, 25, 29, 255];
const STATUS_WHITE: [u8; 4] = [255, 255, 255, 255];
pub const STATUS_OVERLAY_SIZE: u32 = 32;

// Three-column glyphs leave enough room for two digits in the 32px Windows
// overlay. The old five-column glyph was reduced to an unreadable pink dot
// when Windows rendered that overlay at taskbar size.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b110, 0b001, 0b010, 0b100, 0b111],
    [0b110, 0b001, 0b010, 0b001, 0b110],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b110, 0b001, 0b110],
    [0b011, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b110],
];

pub fn status_overlay_rgba(active: bool, unread: u32) -> Option<Vec<u8>> {
    let unread = if active { 0 } else { unread };
    if !active && unread == 0 {
        return None;
    }
    // Windows scales taskbar overlays to the current taskbar DPI. A 32px
    // source gives the compact glyph enough samples to remain visible after
    // that final scale-down instead of becoming a plain colored dot.
    let size = STATUS_OVERLAY_SIZE;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    draw_status(&mut rgba, size, size, active, unread);
    Some(rgba)
}

pub fn composite_status_rgba(
    base: &[u8],
    width: u32,
    height: u32,
    active: bool,
    unread: u32,
) -> Option<Vec<u8>> {
    let length = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if width == 0 || height == 0 || base.len() != length {
        return None;
    }

    let unread = if active { 0 } else { unread };
    let mut rgba = base.to_vec();
    if active || unread > 0 {
        draw_status(&mut rgba, width, height, active, unread);
    }
    Some(rgba)
}

fn draw_status(rgba: &mut [u8], width: u32, height: u32, active: bool, unread: u32) {
    let minimum = width.min(height);
    if unread > 0 {
        // The badge must survive Windows reducing a 32px overlay to the
        // taskbar's small icon size. Keep it large, with a compact glyph.
        let maximum_radius = (minimum.saturating_sub(2) / 2).max(1);
        let small_overlay = minimum <= 16;
        let radius = if small_overlay {
            maximum_radius
        } else {
            ((minimum / 3).max(6)).min(maximum_radius)
        };
        let center_x = if small_overlay {
            width / 2
        } else {
            width.saturating_mul(2) / 3
        };
        let center_y = if small_overlay {
            height / 2
        } else {
            height.saturating_mul(2) / 3
        };
        draw_badge(rgba, width, height, center_x, center_y, radius, unread);
    }
    if active {
        let radius = (minimum / 8).max(2);
        let (center_x, center_y) = if unread > 0 {
            (width / 4, height / 4)
        } else {
            (width.saturating_mul(2) / 3, height.saturating_mul(2) / 3)
        };
        draw_circle(
            rgba,
            width,
            height,
            center_x,
            center_y,
            radius,
            STATUS_GREEN,
        );
    }
}

fn draw_badge(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: u32,
    center_y: u32,
    radius: u32,
    unread: u32,
) {
    draw_circle(rgba, width, height, center_x, center_y, radius, STATUS_RED);

    let digits: Vec<usize> = if unread >= 10 {
        vec![
            (unread.min(99) / 10) as usize,
            (unread.min(99) % 10) as usize,
        ]
    } else {
        vec![unread as usize]
    };
    let unit_width = (digits.len() * 3 + digits.len().saturating_sub(1)) as u32;
    let available = radius.saturating_mul(2).saturating_sub(4);
    let scale = ((available / unit_width.max(1)).min(available / 5)).max(1);
    let glyph_width = unit_width.saturating_mul(scale);
    let glyph_height = 5 * scale;
    let left = center_x.saturating_sub(glyph_width / 2);
    let top = center_y.saturating_sub(glyph_height / 2);

    for (digit_index, digit) in digits.into_iter().enumerate() {
        for row in 0..5u32 {
            for col in 0..3u32 {
                if DIGITS[digit][row as usize] & (1 << (2 - col)) == 0 {
                    continue;
                }
                for y_offset in 0..scale {
                    for x_offset in 0..scale {
                        put_pixel(
                            rgba,
                            width,
                            height,
                            left.saturating_add(digit_index as u32 * 4 * scale)
                                .saturating_add(col * scale)
                                .saturating_add(x_offset),
                            top.saturating_add(row * scale).saturating_add(y_offset),
                            STATUS_WHITE,
                        );
                    }
                }
            }
        }
    }
}

fn draw_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: u32,
    center_y: u32,
    radius: u32,
    color: [u8; 4],
) {
    let outer = radius.saturating_add(1);
    let outer_squared = (outer as i64) * (outer as i64);
    let inner_squared = (radius as i64) * (radius as i64);
    for y in 0..height {
        for x in 0..width {
            let dx = x as i64 - center_x as i64;
            let dy = y as i64 - center_y as i64;
            let distance_squared = dx * dx + dy * dy;
            if distance_squared <= outer_squared {
                put_pixel(
                    rgba,
                    width,
                    height,
                    x,
                    y,
                    if distance_squared <= inner_squared {
                        color
                    } else {
                        STATUS_DARK
                    },
                );
            }
        }
    }
}

fn put_pixel(rgba: &mut [u8], width: u32, height: u32, x: u32, y: u32, color: [u8; 4]) {
    if x >= width || y >= height {
        return;
    }
    let offset = ((y as usize) * (width as usize) + x as usize) * 4;
    rgba[offset..offset + 4].copy_from_slice(&color);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contains_color(rgba: &[u8], color: [u8; 4]) -> bool {
        rgba.chunks_exact(4).any(|pixel| pixel == color)
    }

    fn color_count(rgba: &[u8], color: [u8; 4]) -> usize {
        rgba.chunks_exact(4).filter(|pixel| *pixel == color).count()
    }

    #[test]
    fn no_status_has_no_overlay() {
        assert!(status_overlay_rgba(false, 0).is_none());
    }

    #[test]
    fn active_status_draws_a_green_mark() {
        let rgba = status_overlay_rgba(true, 0).expect("active mark");
        assert_eq!(
            rgba.len(),
            (STATUS_OVERLAY_SIZE * STATUS_OVERLAY_SIZE * 4) as usize
        );
        assert!(contains_color(&rgba, STATUS_GREEN));
        assert!(!contains_color(&rgba, STATUS_RED));
    }

    #[test]
    fn unread_status_draws_a_red_badge_and_white_digits() {
        let rgba = status_overlay_rgba(false, 7).expect("unread badge");
        assert!(contains_color(&rgba, STATUS_RED));
        assert!(contains_color(&rgba, STATUS_WHITE));
        assert!(color_count(&rgba, STATUS_WHITE) >= 20);
    }

    #[test]
    fn active_status_suppresses_unread_badge() {
        let rgba = status_overlay_rgba(true, 12).expect("combined status");
        assert!(contains_color(&rgba, STATUS_GREEN));
        assert!(!contains_color(&rgba, STATUS_RED));
        assert!(!contains_color(&rgba, STATUS_WHITE));
    }

    #[test]
    fn composite_preserves_unmarked_base_pixels() {
        let base = [8u8, 9, 10, 255].repeat(64 * 64);
        let rgba = composite_status_rgba(&base, 64, 64, true, 1).expect("composite icon");
        assert_eq!(&rgba[0..4], &base[0..4]);
        assert_ne!(rgba, base);
        assert!(contains_color(&rgba, STATUS_GREEN));
        assert!(!contains_color(&rgba, STATUS_RED));
    }

    #[test]
    fn invalid_base_dimensions_are_rejected() {
        assert!(composite_status_rgba(&[0u8; 4], 2, 2, true, 1).is_none());
    }
}
