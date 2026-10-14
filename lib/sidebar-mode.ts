// Which view of the Side Bar is showing, and what is still waiting to happen to
// it. Pure and browser-safe, so the rules are tested rather than re-derived in
// the component, which only feeds it events.
//
// The Side Bar has two views: "This chat" (side questions about the main
// conversation) and "New chat" (the separate sidebar chat). "This chat" exists
// only while the main chat can have side questions, so what was chosen is
// dropped when it goes: a choice made for one chat must not jump back by itself
// when another one appears.

export type SidebarMode = "session" | "new";

export interface SidebarModeState {
  /** What was chosen. It counts only while "This chat" exists. */
  mode: SidebarMode;
  /** A bare `/btw` asked for the cursor in the question box and it has not landed yet. */
  focusPending: boolean;
  /** The newest request already taken. A request is taken once, however often the component renders. */
  handledToken: number;
}

export type SidebarModeEvent =
  /** The person flipped the switch. */
  | { type: "choose"; mode: SidebarMode }
  /** A `/btw` typed in the main composer asked for "This chat" (each request has its own token). */
  | { type: "request"; token: number; focus: boolean }
  /** "This chat" stopped existing: another engine, an older omp, a chat with no id yet. */
  | { type: "gone" }
  /** The question box took the cursor. */
  | { type: "focused" };

export const INITIAL_SIDEBAR_MODE: SidebarModeState = { mode: "new", focusPending: false, handledToken: 0 };

/** The same object comes back when nothing changed, so React skips the render. */
export function sidebarModeReducer(state: SidebarModeState, event: SidebarModeEvent): SidebarModeState {
  switch (event.type) {
    case "choose":
      return state.mode === event.mode ? state : { ...state, mode: event.mode };
    case "request":
      if (event.token <= state.handledToken) return state;
      return { mode: "session", focusPending: state.focusPending || event.focus, handledToken: event.token };
    case "gone":
      return state.mode === "new" && !state.focusPending ? state : { ...state, mode: "new", focusPending: false };
    case "focused":
      return state.focusPending ? { ...state, focusPending: false } : state;
  }
}
