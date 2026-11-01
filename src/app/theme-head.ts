// Loaded as a classic script in <head> of every page (the CSP allows no
// inline script), so a stored theme applies before anything paints. Built
// to theme-<hash>.js by scripts/build.mjs.
import { applyTheme, watchTheme } from './theme.ts';

applyTheme();
watchTheme();
