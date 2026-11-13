import {
  BarChart3,
  CreditCard,
  FolderTree,
  Globe2,
  HelpCircle,
  Layers,
  LayoutDashboard,
  LayoutTemplate,
  MessageSquare,
  MousePointer2,
  Navigation,
  Sparkles,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react';

const CATEGORY_MARK: Record<string, LucideIcon> = {
  'ai-chats': MessageSquare,
  'ai-parts': MessageSquare,
  'ai-screens': LayoutDashboard,
  'ai-signals': Sparkles,
  animation: Sparkles,
  backgrounds: Layers,
  buttons: Square,
  'calls-to-action': LayoutTemplate,
  cards: CreditCard,
  carousels: LayoutTemplate,
  'charts-data-viz': BarChart3,
  clients: Layers,
  contact: MessageSquare,
  cursors: MousePointer2,
  dashboards: LayoutDashboard,
  docks: Navigation,
  'empty-states': Square,
  faqs: HelpCircle,
  features: LayoutTemplate,
  'file-trees': FolderTree,
  footers: LayoutTemplate,
  forms: LayoutTemplate,
  galleries: LayoutTemplate,
  heroes: LayoutTemplate,
  icons: Sparkles,
  lists: Layers,
  maps: Globe2,
  menus: Navigation,
  'pricing-sections': CreditCard,
  progress: BarChart3,
  sidebars: Navigation,
  tags: Type,
  'team-sections': Layers,
  testimonials: MessageSquare,
  texts: Type,
  timelines: BarChart3,
  toggles: Square,
  videos: LayoutTemplate,
};

const CATEGORY_LABEL: Record<string, string> = {
  'ai-signals': 'Signals',
  'ai-parts': 'Chat Parts',
  'ai-screens': 'Chat Screens',
};

export function categoryLabel(name: string) {
  if (CATEGORY_LABEL[name]) return CATEGORY_LABEL[name];
  return name
    .split('-')
    .map((word) => (word === 'ai' ? 'AI' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

export function categoryMark(name: string): LucideIcon {
  return CATEGORY_MARK[name] ?? Layers;
}
