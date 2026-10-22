'use client';

import {
  BadgeCheck, Boxes, CalendarDays, ChartLine, Contact, Gem, Gift, Landmark, LayoutDashboard, Lightbulb, ListOrdered, Palette,
  Receipt, ScrollText, Settings, ShieldAlert, ShoppingBag, Sparkles, UserRound, Users, UsersRound, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  BadgeCheck, Boxes, CalendarDays, ChartLine, Contact, Gem, Gift, Landmark, LayoutDashboard, Lightbulb, ListOrdered, Palette,
  Receipt, ScrollText, Settings, ShieldAlert, ShoppingBag, Sparkles, UserRound, Users, UsersRound,
};

export function NavIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? LayoutDashboard;
  return <I className={className} aria-hidden />;
}
