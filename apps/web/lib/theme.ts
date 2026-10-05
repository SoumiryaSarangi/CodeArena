export type Theme = 'dark' | 'light';
export const THEME_KEY = 'ca-theme';

/**
 * Runs inline in <head> before first paint so there is no flash (UI_UX §5.1): stored choice,
 * else the OS preference. Storage access is wrapped because it can throw (private mode).
 */
export const themeInitScript = `(function(){try{var t=null;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})()`;
