import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches. `undefined` on the server and in the first
 * client render (no window yet), so callers can avoid mounting both a
 * desktop and a mobile variant of something heavy.
 */
export function useMediaQuery(query: string): boolean | undefined {
	return useSyncExternalStore(
		(onChange) => {
			const mql = window.matchMedia(query);
			mql.addEventListener("change", onChange);
			return () => mql.removeEventListener("change", onChange);
		},
		() => window.matchMedia(query).matches,
		() => undefined,
	);
}

/** The `lg:` breakpoint (1024px): the agent panel docks at the right from here up. */
export function useIsDesktop(): boolean | undefined {
	return useMediaQuery("(min-width: 1024px)");
}
