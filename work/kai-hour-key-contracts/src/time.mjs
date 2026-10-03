export const asTime = (value) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid ISO date-time: ${value}`);
  return time;
};

export function validateSlotWindow(slot) {
  const start = asTime(slot.slotStart);
  const lock = asTime(slot.lockDeadline);
  const end = asTime(slot.slotEnd);
  if (!(lock <= start && start < end)) throw new Error('SLOT_WINDOW_INVALID');
  if (!slot.timeZone || typeof slot.timeZone !== 'string') throw new Error('SLOT_TIME_ZONE_INVALID');
  return true;
}

export function slotState(slot, now) {
  validateSlotWindow(slot);
  const current = asTime(now);
  if (current < asTime(slot.lockDeadline)) return 'before_lock';
  if (current < asTime(slot.slotStart)) return 'locked_window';
  if (current < asTime(slot.slotEnd)) return 'active';
  return 'expired';
}
