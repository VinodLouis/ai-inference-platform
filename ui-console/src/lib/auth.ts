import type { User } from "../types";

export function hasRole(user: User | null, role: string): boolean {
  const roles = user?.roles || [];
  return Array.isArray(roles) && roles.includes(role);
}

export function isAdmin(user: User | null): boolean {
  return hasRole(user, "admin");
}

export function isInferenceUser(user: User | null): boolean {
  const roles = user?.roles || [];
  if (!Array.isArray(roles)) return false;

  return (
    roles.includes("user") ||
    roles.includes("premium") ||
    roles.includes("enterprise")
  );
}

export function splitRoles(rolesText: string): string[] {
  return rolesText
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
