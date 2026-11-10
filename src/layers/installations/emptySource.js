/**
 * The Swedish fork does not offer mapped military installations: this source
 * answers every view with no sites, without loading the bundled names, the
 * map tiles, the server route or Google Places. The layer and its callers
 * (Contacts, Cockpit, share links) keep working and simply find nothing.
 * @returns {{destroy(): void, getMappedSites(): Promise<object>,
 *   searchNearby(): Promise<{places: object[]}>}}
 */
export function createEmptyInstallationSource() {
  return {
    destroy() {},
    async getMappedSites() {
      return {
        records: [],
        droppedCount: 0,
        status: 'ok',
        saturated: false,
        tileSource: true,
      };
    },
    async searchNearby() {
      return { places: [] };
    },
  };
}
