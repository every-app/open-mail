import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` while `active` (a ticking label). */
export function useNow(intervalMs: number, active = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, active]);
	return now;
}
