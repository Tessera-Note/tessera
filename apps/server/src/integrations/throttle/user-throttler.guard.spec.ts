import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from './user-throttler.guard';

describe('UserThrottlerGuard.getTracker', () => {
  function build() {
    return Object.create(UserThrottlerGuard.prototype) as UserThrottlerGuard;
  }

  it('keys on the nested user id (req.user.user.id), matching how Passport populates req.user', async () => {
    const guard = build();
    const req = { user: { user: { id: 'user-1' } } };

    const tracker = await (guard as any).getTracker(req);

    expect(tracker).toBe('user:user-1');
  });

  it('keys on a flat user id (req.user.id) as a fallback shape', async () => {
    const guard = build();
    const req = { user: { id: 'user-1' } };

    const tracker = await (guard as any).getTracker(req);

    expect(tracker).toBe('user:user-1');
  });

  it('falls back to the superclass tracker (IP-based) when there is no user', async () => {
    const guard = build();
    const req = {};

    const superSpy = jest
      .spyOn(ThrottlerGuard.prototype as any, 'getTracker')
      .mockResolvedValue('ip:127.0.0.1');

    const tracker = await (guard as any).getTracker(req);

    expect(superSpy).toHaveBeenCalledWith(req);
    expect(tracker).toBe('ip:127.0.0.1');
    expect(tracker.startsWith('user:')).toBe(false);

    superSpy.mockRestore();
  });
});
