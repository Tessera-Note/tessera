/**
 * Режим открытия страницы.
 *
 * Проверяется не столько само правило, сколько его однократность: экран
 * применяет его эффектом, а эффект выполняется на каждом ответе сервера.
 */

import { describe, expect, it } from 'vitest';
import { editModeGate } from './edit-mode';

describe('editModeGate', () => {
  it('открывает правку, когда так просит предпочтение', () => {
    expect(editModeGate().decide('p1', true, 'edit')).toBe(true);
  });

  it('без предпочтения открывает чтение', () => {
    expect(editModeGate().decide('p1', true, undefined)).toBe(false);
    expect(editModeGate().decide('p1', true, 'read')).toBe(false);
  });

  it('без права правки предпочтение не действует', () => {
    expect(editModeGate().decide('p1', false, 'edit')).toBe(false);
  });

  it('для той же страницы решает один раз', () => {
    const gate = editModeGate();
    expect(gate.decide('p1', true, 'edit')).toBe(true);
    expect(gate.decide('p1', true, 'edit')).toBeNull();
    expect(gate.decide('p1', true, 'read')).toBeNull();
  });

  it('на другой странице решает заново', () => {
    const gate = editModeGate();
    expect(gate.decide('p1', true, 'edit')).toBe(true);
    expect(gate.decide('p2', true, 'read')).toBe(false);
  });
});
