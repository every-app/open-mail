import type { ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { SegmentedToggle } from "~/components/SegmentedToggle";
import {
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "~/components/ui/dropdown-menu";
import { type ThemePreference, useThemePreference } from "~/lib/theme";

const THEME_OPTIONS: {
	value: ThemePreference;
	label: string;
	icon: ReactNode;
}[] = [
	{ value: "system", label: "System", icon: <Monitor /> },
	{ value: "light", label: "Light", icon: <Sun /> },
	{ value: "dark", label: "Dark", icon: <Moon /> },
];

/** System / Light / Dark segmented radio, for a settings page. */
export function ThemePreferenceRadio() {
	const { themePreference, setThemePreference } = useThemePreference();

	return (
		<SegmentedToggle
			items={THEME_OPTIONS}
			value={themePreference}
			onChange={setThemePreference}
		/>
	);
}

/** System / Light / Dark as radio items, for a DropdownMenuContent (the account menu). */
export function ThemePreferenceMenuItems() {
	const { themePreference, setThemePreference } = useThemePreference();

	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel>Theme</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={themePreference}
				onValueChange={(value) => setThemePreference(value as ThemePreference)}
			>
				{THEME_OPTIONS.map((option) => (
					<DropdownMenuRadioItem key={option.value} value={option.value}>
						{option.icon}
						{option.label}
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
		</DropdownMenuGroup>
	);
}
