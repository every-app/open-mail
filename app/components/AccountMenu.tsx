import { useQuery } from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import { ThemePreferenceMenuItems } from "~/components/ThemePreferenceMenuItems";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { meQuery } from "~/services/api";

/**
 * The person (from /api/v1/me), the same menu on every page: who is signed
 * in, the theme, `children` (the mail frame adds Keyboard shortcuts), and the
 * way back to Every App.
 *
 * There is no "Sign out" here. The app has no session of its own: the
 * gateway signs people in and out of every app at once, from its own pages.
 * A "Sign out" that only opened the gateway's home read as if it ended the
 * session, so the item says what it does.
 */
export function AccountMenu({ children }: { children?: ReactNode }) {
	const { data: me } = useQuery({ ...meQuery, retry: false });
	const initial = (me?.email?.[0] ?? "?").toUpperCase();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className="rounded-full"
						aria-label={me ? `Account: ${me.email}` : "Account"}
					/>
				}
			>
				<span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
					{initial}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="flex items-center gap-3 py-2">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
							{initial}
						</span>
						<span className="min-w-0">
							<span className="block truncate text-sm font-medium text-foreground">
								{me?.email ?? "Loading…"}
							</span>
							{me && <span className="block text-xs capitalize">{me.role}</span>}
						</span>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<ThemePreferenceMenuItems />
				{children && (
					<>
						<DropdownMenuSeparator />
						{children}
					</>
				)}
				{me?.gatewayUrl && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem render={<a href={me.gatewayUrl} />}>
							<LayoutGrid />
							Back to Every App
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
