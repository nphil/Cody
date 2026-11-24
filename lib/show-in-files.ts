/**
 * "Show in Files": the file explorer is rooted at the sidebar's selected
 * project and has no address of its own, so other parts of the app (Settings ›
 * Disk space) ask the sidebar to select that folder and open the explorer with a
 * window event. The sidebar listens in components/SessionSidebar.tsx.
 */
export const SHOW_IN_FILES_EVENT = "cody:show-in-files";

export function requestShowInFiles(path: string): void {
  window.dispatchEvent(new CustomEvent<{ path: string }>(SHOW_IN_FILES_EVENT, { detail: { path } }));
}
