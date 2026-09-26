export type PageId = "home" | "games" | "apps" | "files" | "settings";

export type NavItem = {
  id: PageId;
  title: string;
  subtitle: string;
  accent: string;
};
