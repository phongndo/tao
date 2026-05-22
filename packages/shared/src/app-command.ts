export type PaneFocusDirection = 'left' | 'down' | 'up' | 'right'

export type AppCommand =
  | { type: 'toggle-sidebar' }
  | { type: 'toggle-right-sidebar' }
  | { type: 'new-tab' }
  | { type: 'close-tab' }
  | { type: 'close-pane' }
  | { type: 'split-pane-vertical' }
  | { type: 'split-pane-horizontal' }
  | { type: 'switch-workspace'; index: number }
  | { type: 'switch-tab'; index: number }
  | { type: 'focus-pane'; direction: PaneFocusDirection }
  | { type: 'focus-terminal' }
  | { type: 'search-terminal' }
