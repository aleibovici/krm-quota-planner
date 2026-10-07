/** Cross-module callbacks wired once at startup (avoids import cycles). */
export const hooks = {
  replan: async () => {},
  afterStructuralChange: () => {},
  draw: async () => {},
  removeAddition: () => {},
  undoChange: () => {},
};
