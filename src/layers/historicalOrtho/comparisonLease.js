import { msg } from '../../i18n/index.js';

/**
 * The imagery-comparison lease for imagery that should drape on the globe
 * rather than on Google's 3D tiles: while it is held on Google 3D the map
 * goes to Esri (policy `esri-if-photoreal`), and its release goes back when
 * the lease's own switch still owns the map. Recent Imagery's rules, kept
 * apart so the historical photos (and a then/now swipe after them) share
 * one copy:
 * - one owner at a time: another scene's lease is refused
 *   (`Comparison in use by another scene`) and nothing is retried until
 *   the lease is let go;
 * - a switch that did not land on Esri leaves it `unavailable`;
 * - while wanted, a manual switch to Google 3D is answered with a new
 *   lease (the map goes back to Esri and the notice says so); an automatic
 *   one (the controller falling back after Esri failed) is not, and the
 *   lease lets go without a switch of its own;
 * - nothing new is taken while a release is still restoring the map.
 */

export const COMPARISON_IN_USE = msg('Comparison in use by another scene');
export const COMPARISON_UNAVAILABLE = msg('Esri map unavailable');
export const ESRI_KEPT = msg(
  'The historical photos keep the Esri map · turn the layer off for Google 3D',
);

/**
 * @param {{ owner: string, onChange?: () => void, isLive?: () => boolean, label?: string }} options
 *   `onChange`: the lease settled, was refused or let go (redraw).
 *   `isLive`: whether its owner still exists (false once destroyed).
 */
export function createComparisonLease({
  owner,
  onChange = () => {},
  isLive = () => true,
  label = owner,
} = {}) {
  if (!owner) throw new TypeError('A comparison lease needs an owner');
  let controller = null;
  let lease = null;
  let fromPhotoreal = false;
  /** The stack the lease switched to, once ready. */
  let stackId = null;
  /** The controller's switch generation right after the lease was taken. */
  let generation = null;
  /** The last switch generation answered with a new lease. */
  let keptGeneration = null;
  /**
   * The lease was let go because the controller fell back to Google 3D on
   * its own; the next manual switch to Google 3D may take Esri again.
   */
  let droppedByFallback = false;
  let releasing = null;
  let ready = false;
  let error = null;
  let notice = null;
  /** No controller offers a lease: the imagery stays where the map is. */
  let unsupported = false;

  function forget() {
    droppedByFallback = false;
    lease = null;
    fromPhotoreal = false;
    stackId = null;
    generation = null;
    ready = false;
    error = null;
    unsupported = false;
  }

  /** Take the lease, unless held, refused, settling or being released. */
  function acquire() {
    if (lease || releasing || error || ready || unsupported) return;
    if (!controller?.acquireImageryComparison) {
      unsupported = true;
      return;
    }
    const photoreal = controller.getActiveId?.() === 'photoreal';
    let taken;
    try {
      taken = controller.acquireImageryComparison({
        owner,
        switchPolicy: 'esri-if-photoreal',
      });
    } catch {
      error = COMPARISON_IN_USE;
      return;
    }
    lease = taken;
    fromPhotoreal = photoreal;
    // Read after the lease issued its switch, so that switch is known as ours.
    generation = controller.getSwitchGeneration?.() ?? null;
    Promise.resolve(taken.ready)
      .catch(() => null)
      .then((result) => {
        if (!isLive() || lease !== taken) return;
        if (result?.status === 'ready') {
          ready = true;
          stackId = result.activeId ?? null;
        } else error = COMPARISON_UNAVAILABLE;
        onChange();
      });
  }

  /**
   * Hand the lease back. The release restores the map asynchronously; no
   * new lease is taken until it settles, and then the owner redraws.
   */
  function release() {
    const held = lease;
    forget();
    if (notice === ESRI_KEPT) notice = null;
    if (!held) return;
    const settling = Promise.resolve()
      .then(() => held.release())
      .catch((failure) => {
        console.warn(`[Data:${label}] comparison release failed:`, failure);
      })
      .then(() => {
        if (releasing === settling) releasing = null;
        if (isLive()) onChange();
      });
    releasing = settling;
  }

  /**
   * A settled stack switch while the imagery is wanted: a manual switch to
   * Google 3D takes Esri back with a new lease; an automatic one lets the
   * lease go. Once per switch generation, never while releasing, and never
   * without a lease to renew or one a fallback let go, so a lease another
   * owner holds stays refused.
   * @returns {boolean} Whether the lease was renewed, refused or let go.
   */
  function follow() {
    if (releasing || !isLive()) return false;
    if (!lease && !droppedByFallback) return false;
    if (controller?.getActiveId?.() !== 'photoreal') return false;
    const now = controller.getSwitchGeneration?.() ?? null;
    if (now === generation || now === keptGeneration) return false;
    keptGeneration = now;
    const automatic = controller.getSwitchOrigin?.() === 'automatic';
    const previous = lease;
    forget();
    try {
      void previous?.release();
    } catch (failure) {
      console.warn(`[Data:${label}] comparison release failed:`, failure);
    }
    if (automatic) {
      droppedByFallback = true;
      error = COMPARISON_UNAVAILABLE;
      if (notice === ESRI_KEPT) notice = null;
      return true;
    }
    acquire();
    if (lease) notice = ESRI_KEPT;
    else if (notice === ESRI_KEPT) notice = null;
    return true;
  }

  return {
    /** The map stack controller whose lease is taken (or none). */
    attach(next) {
      controller = next || null;
    },
    acquire,
    release,
    follow,
    /**
     * `none` (not wanted), `acquiring`, `ready`, `releasing`, `unavailable`
     * (refused or failed; `error` says which) or `unsupported` (no
     * controller offers one).
     */
    status() {
      if (releasing) return 'releasing';
      if (unsupported) return 'unsupported';
      if (error) return 'unavailable';
      if (ready) return 'ready';
      if (lease) return 'acquiring';
      return 'none';
    },
    /** Why there is no lease, or null. */
    error: () => error,
    /** The note for a lease renewed after a manual switch, or null. */
    notice: () => notice,
    /** Whether the lease moved the map off Google 3D and still owns it. */
    borrowedEsri: () =>
      Boolean(lease) &&
      ready &&
      fromPhotoreal &&
      stackId !== null &&
      controller?.getActiveId?.() === stackId,
    /** Whether a lease is held, settling or refused (anything to let go). */
    held: () => Boolean(lease || ready || error || unsupported),
  };
}
