import { startApplicationChrome } from '../app/startupChrome.js';
import { playOpeningIntro } from '../app/openingIntro.js';
import { initKeySetup } from '../keySetup.js';
import { takeGlobeSaverReload } from '../globeSaver.js';
import { streetLevelFromParams } from '../view/index.js';
export function startStandaloneChrome(options) {
  // A Street Level link opens its photos at its view, so it plays no
  // opening. Read now: the address is rewritten once the link restores.
  const streetLevel = streetLevelFromParams(
    new URLSearchParams(globalThis.location?.hash.slice(1) ?? ''),
  );
  // Swedish fork: the 3D button's reload keeps the view it was at and
  // plays no opening (globeSaver.js).
  const globeSwitched = takeGlobeSaverReload();
  return startApplicationChrome({
    initializeSettings: initKeySetup,
    playOpening: streetLevel || globeSwitched ? null : playOpeningIntro,
    ...options,
  });
}
