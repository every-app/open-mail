import { useQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	Bot,
	Check,
	ChevronDown,
	Inbox,
	Keyboard,
	LogOut,
	Menu,
	Search,
	Settings,
	X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
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
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "~/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useIsMobile } from "~/hooks/use-mobile";
import { useHotkeys } from "~/hooks/useHotkeys";
import { useMailRoute } from "~/hooks/useMailRoute";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/cn";
import { folderPath, searchPath } from "~/lib/mail-paths";
import { mailboxDisplayName } from "~/lib/utils";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import { meQuery } from "~/services/api";

function IconTooltip({ label, children }: { label: string; children: React.ReactElement }) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

/** The mailbox name with a menu to switch mailboxes or go back to all of them. */
function MailboxSwitcher({ mailboxId }: { mailboxId: string }) {
	const navigate = useNavigate();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: mailboxes = [] } = useMailboxes();
	const name = mailboxDisplayName(mailbox, mailboxId);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						className="h-9 min-w-0 max-w-56 gap-1 px-2 text-base font-semibold"
						aria-label={`Mailbox: ${name}. Switch mailbox`}
					/>
				}
			>
				<span className="truncate">{name}</span>
				<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-72" align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Mailboxes</DropdownMenuLabel>
					{mailboxes.map((m) => (
						<DropdownMenuItem
							key={m.id}
							onClick={() => navigate(folderPath(m.email, "inbox"))}
							className="items-start"
						>
							<Inbox className="mt-0.5" />
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{mailboxDisplayName(m)}</div>
								<div className="truncate text-xs text-muted-foreground">{m.email}</div>
							</div>
							{m.email === mailboxId && <Check className="mt-0.5 text-primary" />}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => navigate("/")}>
					<ArrowLeft />
					All mailboxes
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Search mail: Enter searches (the search syntax in app/lib/search-parser.ts), `/` focuses, Escape clears. */
function SearchField({
	mailboxId,
	className,
	autoFocus,
	onDone,
}: {
	mailboxId: string;
	className?: string;
	autoFocus?: boolean;
	onDone?: () => void;
}) {
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const inputRef = useRef<HTMLInputElement>(null);
	const isSearchPage = /\/search(\/|$)/.test(location.pathname);
	const urlQuery = isSearchPage ? searchParams.get("q") || "" : "";
	const [query, setQuery] = useState(urlQuery);

	// The field shows the search being looked at, and empties when leaving it.
	useEffect(() => {
		setQuery(urlQuery);
	}, [urlQuery]);

	useHotkeys({
		"/": () => {
			inputRef.current?.focus();
			inputRef.current?.select();
		},
	});

	const performSearch = () => {
		const q = query.trim();
		if (!q) return;
		navigate(searchPath(mailboxId, q));
		inputRef.current?.blur();
		onDone?.();
	};

	const clearSearch = () => {
		setQuery("");
		if (isSearchPage) navigate(folderPath(mailboxId, "inbox"));
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			performSearch();
		}
		if (e.key === "Escape") {
			if (query) clearSearch();
			else {
				inputRef.current?.blur();
				onDone?.();
			}
		}
	};

	return (
		<InputGroup
			className={cn(
				"h-10 rounded-lg border-transparent bg-foreground/[0.06] focus-within:bg-card has-[[data-slot=input-group-control]:focus-visible]:border-border",
				className,
			)}
		>
			<InputGroupAddon>
				<InputGroupButton size="icon-xs" aria-label="Search" onClick={performSearch}>
					<Search />
				</InputGroupButton>
			</InputGroupAddon>
			<InputGroupInput
				ref={inputRef}
				aria-label="Search mail"
				placeholder="Search mail"
				value={query}
				autoFocus={autoFocus}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
			/>
			{query && (
				<InputGroupAddon align="inline-end">
					<InputGroupButton size="icon-xs" aria-label="Clear search" onClick={clearSearch}>
						<X />
					</InputGroupButton>
				</InputGroupAddon>
			)}
		</InputGroup>
	);
}

/** The person (from /api/v1/me): theme, keyboard shortcuts, Sign out (the gateway). */
function AccountMenu() {
	const { data: me } = useQuery({ ...meQuery, retry: false });
	const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);
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
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
					<Keyboard />
					Keyboard shortcuts
				</DropdownMenuItem>
				{me?.gatewayUrl && (
					<DropdownMenuItem render={<a href={me.gatewayUrl} />}>
						<LogOut />
						Sign out
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Gmail's top bar, full width above the sidebar and the main pane (docs/UI.md "Layout"). */
export default function TopBar() {
	const { mailboxId } = useMailRoute();
	const location = useLocation();
	const isMobile = useIsMobile();
	const [mobileSearch, setMobileSearch] = useState(false);
	const toggleSidebar = useUIStore((s) => s.toggleSidebar);
	const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
	const isAgentShown = useUIStore((s) => s.agent.open && !s.agent.minimized);
	const toggleAgent = useUIStore((s) => s.toggleAgent);
	const isSettingsActive = location.pathname.endsWith("/settings");

	if (!mailboxId) return null;

	if (isMobile && mobileSearch) {
		return (
			<header className="flex h-14 shrink-0 items-center gap-1 px-2">
				<Button variant="ghost" size="icon" aria-label="Close search" onClick={() => setMobileSearch(false)}>
					<ArrowLeft />
				</Button>
				<SearchField mailboxId={mailboxId} className="flex-1" autoFocus onDone={() => setMobileSearch(false)} />
			</header>
		);
	}

	return (
		<header className="flex h-14 shrink-0 items-center gap-1 px-2 md:gap-2 md:px-3">
			<IconTooltip label="Main menu">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Main menu"
					onClick={isMobile ? toggleSidebar : toggleSidebarCollapsed}
				>
					<Menu className="size-5" />
				</Button>
			</IconTooltip>

			<div className="flex min-w-0 items-center md:w-52 md:shrink-0">
				<MailboxSwitcher mailboxId={mailboxId} />
			</div>

			<div className="hidden min-w-0 flex-1 md:block">
				<SearchField mailboxId={mailboxId} className="max-w-3xl" />
			</div>

			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Search mail"
					className="md:hidden"
					onClick={() => setMobileSearch(true)}
				>
					<Search className="size-5" />
				</Button>
				<IconTooltip label={isAgentShown ? "Minimize agent" : "Open agent"}>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Agent"
						aria-pressed={isAgentShown}
						onClick={toggleAgent}
						className={cn(isAgentShown && "bg-primary/10 text-primary hover:bg-primary/15")}
					>
						<Bot className="size-5" />
					</Button>
				</IconTooltip>
				<IconTooltip label="Settings">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Mailbox settings"
						aria-current={isSettingsActive ? "page" : undefined}
						className={cn(isSettingsActive && "bg-muted")}
						render={<Link to={`/mailbox/${mailboxId}/settings`} />}
						nativeButton={false}
					>
						<Settings className="size-5" />
					</Button>
				</IconTooltip>
				<AccountMenu />
			</div>
		</header>
	);
}
