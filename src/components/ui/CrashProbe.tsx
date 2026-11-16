import React from 'react';

// Development only: lets the browser tests (and a developer) break one part of the app on purpose, with
// ?wpCrash=<where> in the address (a tab name, "dialog" or "root"), to see that the damage stays in that part.
// In the production build `import.meta.env.DEV` is false, so this never throws and the address does nothing.
export const CrashProbe: React.FC<{ where: string }> = ({ where }) => {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('wpCrash') === where) {
    throw new Error(`Test crash requested for "${where}"`);
  }
  return null;
};
