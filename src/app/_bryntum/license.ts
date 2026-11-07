/**
 * P7 — registers the Bryntum 8.x license key with the documented API,
 * `bryntum.licenseKey = '…'`: a property on the `bryntum` global that Core
 * creates when a Bryntum package loads, set before the first component is
 * created. The App Router has no client entry file, so each client-only
 * Bryntum component calls this right after its imports. The key comes
 * from `BRYNTUM_LICENSE_KEY` on the server, passed down as a prop (a
 * Bryntum key is a client-side key by design); without one the component
 * runs as a trial. Never logged.
 */
export function applyBryntumLicense(licenseKey: string | null | undefined): void {
  if (!licenseKey || typeof window === "undefined") {
    return;
  }
  const global = (window as unknown as { bryntum?: { licenseKey?: string } }).bryntum;
  if (global && global.licenseKey !== licenseKey) {
    global.licenseKey = licenseKey;
  }
}
