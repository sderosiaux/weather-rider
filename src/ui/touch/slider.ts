// Throttle slider → throttle. The slider is a lever grabbed anywhere, not a position picker:
// a drag moves the setting by the distance travelled, so touching it never jumps the power.
import { clamp } from '../input/mapping'

/**
 * One drag step (screen coords, +y = down). Up = more power; the full track length is the full range.
 * Clamped per step: travel past either end is dropped, so reversing answers at once.
 */
export const dragThrottle = (throttle: number, fromY: number, toY: number, trackPx: number): number =>
  trackPx > 0 && Number.isFinite(fromY) && Number.isFinite(toY) ? clamp(throttle + (fromY - toY) / trackPx, 0, 1) : throttle
