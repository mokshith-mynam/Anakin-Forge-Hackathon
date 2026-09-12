/**
 * API Key Pool
 * Manages a pool of up to 10 Anakin API keys and rotates automatically when
 * one is exhausted (rate-limited or out of credits).
 *
 * Keys are read from environment variables:
 *   ANAKIN_API_KEY_1 through ANAKIN_API_KEY_10
 *
 * Rotation logic:
 *   - On a rate-limit or credit-exhausted error, the current key is marked
 *     "cooling down" and the next available key is used immediately.
 *   - After COOLDOWN_MS (60 seconds), a cooled key becomes eligible again,
 *     so the pool effectively cycles rather than being permanently depleted.
 *   - If ALL keys are cooling down, the call waits for the soonest one to
 *     recover rather than failing immediately.
 */

'use strict';

require('dotenv').config();

const COOLDOWN_MS = 90_000; // 90 seconds before a rate-limited key retries (burst limit window)

class KeyPool {
  constructor() {
    // Collect all non-empty keys from env — supports up to 10 keys
    this.keys = [
      process.env.ANAKIN_API_KEY_1,
      process.env.ANAKIN_API_KEY_2,
      process.env.ANAKIN_API_KEY_3,
      process.env.ANAKIN_API_KEY_4,
      process.env.ANAKIN_API_KEY_5,
      process.env.ANAKIN_API_KEY_6,
      process.env.ANAKIN_API_KEY_7,
      process.env.ANAKIN_API_KEY_8,
      process.env.ANAKIN_API_KEY_9,
      process.env.ANAKIN_API_KEY_10,
      // Legacy single-key support
      process.env.ANAKIN_API_KEY,
    ]
      .filter(k => k && k.trim() && !k.includes('your_') && !k.includes('_here'))
      .map(k => k.trim())
      // Deduplicate
      .filter((k, i, arr) => arr.indexOf(k) === i);

    if (this.keys.length === 0) {
      throw new Error(
        'No Anakin API keys found. Set ANAKIN_API_KEY_1 through ANAKIN_API_KEY_10 in your .env file.'
      );
    }

    // Track cooldown state per key: { coolingUntil: timestamp | null }
    this.state = this.keys.map(() => ({ coolingUntil: null, failCount: 0 }));
    this.currentIndex = 0;

    console.log(`[KeyPool] Loaded ${this.keys.length} API key(s).`);
  }

  /**
   * Returns the currently active key.
   * Skips keys that are still cooling down.
   * If all are cooling, waits for the soonest recovery.
   */
  async getKey() {
    const now = Date.now();

    // Find first available (not cooling) key, starting from currentIndex
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      const st  = this.state[idx];
      if (!st.coolingUntil || now >= st.coolingUntil) {
        st.coolingUntil = null; // clear expired cooldown
        this.currentIndex = idx;
        return this.keys[idx];
      }
    }

    // All keys are cooling — wait for the soonest one to recover
    const soonest = Math.min(...this.state.map(s => s.coolingUntil || 0));
    const waitMs  = Math.max(0, soonest - now) + 500; // +500ms buffer
    console.warn(`[KeyPool] All ${this.keys.length} key(s) cooling. Waiting ${(waitMs/1000).toFixed(1)}s…`);
    await sleep(waitMs);

    // After waiting, pick the first recovered key
    const nowAfter = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const st = this.state[i];
      if (!st.coolingUntil || nowAfter >= st.coolingUntil) {
        st.coolingUntil = null;
        this.currentIndex = i;
        return this.keys[i];
      }
    }

    // Fallback — should never happen
    this.currentIndex = 0;
    return this.keys[0];
  }

  /**
   * Mark the current key as rate-limited / exhausted.
   * Rotates to the next available key.
   * @param {string} key - the key that failed (for verification)
   */
  markExhausted(key) {
    const idx = this.keys.indexOf(key);
    if (idx === -1) return;

    this.state[idx].coolingUntil = Date.now() + COOLDOWN_MS;
    this.state[idx].failCount++;

    const label = `key #${idx + 1} (...${key.slice(-8)})`;
    console.warn(`[KeyPool] ${label} rate-limited. Cooling for ${COOLDOWN_MS / 1000}s. Rotating…`);

    // Advance to next key
    this.currentIndex = (idx + 1) % this.keys.length;
  }

  /**
   * Human-readable pool status — useful for logging/debugging.
   */
  status() {
    const now = Date.now();
    return this.keys.map((k, i) => {
      const st = this.state[i];
      const cooling = st.coolingUntil && now < st.coolingUntil;
      return {
        index:    i + 1,
        suffix:   k.slice(-8),
        active:   i === this.currentIndex,
        cooling,
        coolsInMs: cooling ? Math.max(0, st.coolingUntil - now) : 0,
        failCount: st.failCount,
      };
    });
  }

  get size() { return this.keys.length; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Export a singleton so all parts of the app share one pool
module.exports = new KeyPool();
