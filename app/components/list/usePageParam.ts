import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * The list's page, kept in the URL (`?page=2`) so back from a conversation
 * returns to the same page. Other params (`?q=`) stay.
 */
export function usePageParam(): [number, (page: number) => void] {
	const [searchParams, setSearchParams] = useSearchParams();
	const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
	const setPage = useCallback(
		(next: number) => {
			setSearchParams((prev) => {
				const params = new URLSearchParams(prev);
				if (next <= 1) params.delete("page");
				else params.set("page", String(next));
				return params;
			});
		},
		[setSearchParams],
	);
	return [page, setPage];
}
