'use client';

import {
  BadgeCheck, Boxes, CalendarDays, ChartLine, Contact, Gem, Gift, Images, Landmark, LayoutDashboard, Lightbulb, ListOrdered, Palette, PartyPopper,
  Receipt, ScrollText, Settings, Share2, ShieldAlert, ShoppingBag, Sparkles, UserRound, Users, UsersRound, Wallet, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  BadgeCheck, Boxes, CalendarDays, ChartLine, Contact, Gem, Gift, Images, Landmark, LayoutDashboard, Lightbulb, ListOrdered, Palette, PartyPopper,
  Receipt, ScrollText, Settings, Share2, ShieldAlert, ShoppingBag, Sparkles, UserRound, Users, UsersRound, Wallet,
};

export function NavIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? LayoutDashboard;
  return <I className={className} aria-hidden />;
}
