/**
 * THE APP REGISTRY — the single source of truth for what this platform sells.
 *
 * Every consumer derives from this file:
 *   catalog   seeds the marketplace from it
 *   billing   seeds prices from it
 *   tenancy   seeds the grantable permission set from it
 *   gateway   routes /api/<slug>/* to the owning service from it
 *   web       builds the sidebar, dashboard, marketing site and command palette
 *
 * Adding an app to the platform means adding an entry here and deploying its
 * service. No shell code, no routing table and no nav component changes.
 */

export const APP_CATEGORIES = [
  {
    slug: 'sales',
    name: 'Sales',
    tagline: 'Win more, guess less',
    description: 'Everything from first touch to signed deal.',
    icon: 'TrendingUp',
    accent: 'indigo',
  },
  {
    slug: 'marketing',
    name: 'Marketing',
    tagline: 'Fill the pipeline',
    description: 'Campaigns, audiences and the numbers behind them.',
    icon: 'Megaphone',
    accent: 'pink',
  },
  {
    slug: 'commerce',
    name: 'Commerce & POS',
    tagline: 'Sell anywhere',
    description: 'Online store, counter sales and subscriptions.',
    icon: 'ShoppingBag',
    accent: 'rose',
  },
  {
    slug: 'service',
    name: 'Customer Service',
    tagline: 'Answer faster',
    description: 'Tickets, field work and self-service.',
    icon: 'Headphones',
    accent: 'orange',
  },
  {
    slug: 'finance',
    name: 'Finance',
    tagline: 'Money in, money out',
    description: 'Invoicing, books, expenses and assets.',
    icon: 'Wallet',
    accent: 'cyan',
  },
  {
    slug: 'operations',
    name: 'Operations',
    tagline: 'Run the day-to-day',
    description: 'Stock, purchasing, production and maintenance.',
    icon: 'Boxes',
    accent: 'amber',
  },
  {
    slug: 'people',
    name: 'Human Resources',
    tagline: 'Hire, manage, pay',
    description: 'The full employee lifecycle.',
    icon: 'UsersRound',
    accent: 'emerald',
  },
  {
    slug: 'projects',
    name: 'Project Management',
    tagline: 'Ship on time',
    description: 'Plans, tasks, timesheets and capacity.',
    icon: 'ListChecks',
    accent: 'violet',
  },
  {
    slug: 'collaboration',
    name: 'Email, Storage & Collaboration',
    tagline: 'Work together',
    description: 'Mail, files, chat, meetings and signatures.',
    icon: 'MessagesSquare',
    accent: 'blue',
  },
  {
    slug: 'legal',
    name: 'Legal',
    tagline: 'Stay covered',
    description: 'Contracts, compliance and obligations.',
    icon: 'Scale',
    accent: 'slate',
  },
  {
    slug: 'security',
    name: 'Security & IT',
    tagline: 'Keep control',
    description: 'Access, devices and the audit trail.',
    icon: 'ShieldCheck',
    accent: 'teal',
  },
  {
    slug: 'analytics',
    name: 'BI & Analytics',
    tagline: 'Understand the business',
    description: 'Cross-app dashboards and reporting.',
    icon: 'BarChart3',
    accent: 'fuchsia',
  },
  {
    slug: 'developer',
    name: 'Developer Platform',
    tagline: 'Extend and automate',
    description: 'Automation, APIs and integrations.',
    icon: 'Code2',
    accent: 'purple',
  },
];

const INR = 'INR';

/** Terse helper so 40 app entries stay readable. */
const price = (monthly, per = 'user') => ({
  monthly,
  annual: monthly * 10,
  currency: INR,
  per,
});

export const APPS = [
  // ══════════════════════════════════════════════════════ CORE (always on)
  {
    slug: 'core',
    name: 'Workspace',
    tagline: 'Your organization, people and settings',
    description:
      'The foundation every app builds on: your organization, members, roles, permissions and workspace settings.',
    category: 'operations',
    icon: 'LayoutGrid',
    color: 'slate',
    service: 'tenancy',
    core: true,
    price: price(0, 'org'),
    features: ['core.members', 'core.roles', 'core.settings', 'core.audit'],
    permissions: [
      'core.members.view', 'core.members.invite', 'core.members.edit', 'core.members.delete',
      'core.roles.view', 'core.roles.manage',
      'core.settings.view', 'core.settings.manage',
      'core.audit.view',
      'billing.subscription.view', 'billing.subscription.manage',
      'catalog.apps.view', 'catalog.apps.manage',
    ],
    nav: [],
    dependencies: [],
  },

  // ══════════════════════════════════════════════════════════════════ SALES
  {
    slug: 'crm',
    name: 'CRM',
    tagline: 'Leads, deals and the pipeline that closes them',
    description:
      'Capture every lead, work a visual pipeline, and keep the full history of calls, meetings and notes against each customer. The system of record for who your customers are.',
    category: 'sales',
    icon: 'Target',
    color: 'indigo',
    service: 'crm',
    price: price(799),
    flagship: true,
    highlights: ['Visual drag-drop pipeline', 'Lead scoring', 'Email & call logging', 'Revenue forecasting'],
    features: ['crm.leads', 'crm.contacts', 'crm.companies', 'crm.deals', 'crm.pipeline', 'crm.activities', 'crm.email', 'crm.forecasting'],
    permissions: [
      'crm.leads.view', 'crm.leads.create', 'crm.leads.edit', 'crm.leads.delete', 'crm.leads.export',
      'crm.contacts.view', 'crm.contacts.create', 'crm.contacts.edit', 'crm.contacts.delete',
      'crm.companies.view', 'crm.companies.create', 'crm.companies.edit', 'crm.companies.delete',
      'crm.deals.view', 'crm.deals.create', 'crm.deals.edit', 'crm.deals.delete',
      'crm.pipeline.view', 'crm.pipeline.manage',
      'crm.activities.view', 'crm.activities.create',
      'crm.reports.view',
    ],
    nav: [
      { label: 'Overview', path: '/crm', icon: 'LayoutDashboard', permission: 'crm.deals.view' },
      { label: 'Leads', path: '/crm/leads', icon: 'Sparkles', permission: 'crm.leads.view' },
      { label: 'Pipeline', path: '/crm/pipeline', icon: 'Kanban', permission: 'crm.pipeline.view' },
      { label: 'Deals', path: '/crm/deals', icon: 'HandCoins', permission: 'crm.deals.view' },
      { label: 'Contacts', path: '/crm/contacts', icon: 'Contact', permission: 'crm.contacts.view' },
      { label: 'Companies', path: '/crm/companies', icon: 'Building2', permission: 'crm.companies.view' },
      { label: 'Activities', path: '/crm/activities', icon: 'CalendarClock', permission: 'crm.activities.view' },
    ],
    widgets: [
      { id: 'crm.pipeline_value', title: 'Pipeline value', size: 'sm', permission: 'crm.deals.view' },
      { id: 'crm.deals_won', title: 'Won this month', size: 'sm', permission: 'crm.deals.view' },
      { id: 'crm.conversion', title: 'Lead conversion', size: 'sm', permission: 'crm.leads.view' },
      { id: 'crm.funnel', title: 'Sales funnel', size: 'lg', permission: 'crm.pipeline.view' },
      { id: 'crm.upcoming', title: 'Follow-ups due', size: 'md', permission: 'crm.activities.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'quotes',
    name: 'Quotations & Orders',
    tagline: 'From quote to signed order',
    description:
      'Build branded quotations, send them for approval, and turn accepted quotes into sales orders that flow straight into invoicing and stock.',
    category: 'sales',
    icon: 'FileSignature',
    color: 'indigo',
    service: 'quotes',
    price: price(499),
    highlights: ['Branded quote templates', 'Online acceptance', 'Approval rules', 'Order conversion'],
    features: ['quotes.templates', 'quotes.quotations', 'quotes.orders', 'quotes.approvals'],
    permissions: [
      'quotes.quotations.view', 'quotes.quotations.create', 'quotes.quotations.edit',
      'quotes.quotations.delete', 'quotes.quotations.send', 'quotes.quotations.approve',
      'quotes.orders.view', 'quotes.orders.create', 'quotes.orders.confirm',
    ],
    nav: [
      { label: 'Quotations', path: '/quotes', icon: 'FileSignature', permission: 'quotes.quotations.view' },
      { label: 'Sales orders', path: '/quotes/orders', icon: 'ClipboardCheck', permission: 'quotes.orders.view' },
      { label: 'Templates', path: '/quotes/templates', icon: 'LayoutTemplate', permission: 'quotes.quotations.edit' },
    ],
    widgets: [
      { id: 'quotes.open_value', title: 'Quotes awaiting reply', size: 'sm', permission: 'quotes.quotations.view' },
      { id: 'quotes.win_rate', title: 'Quote win rate', size: 'sm', permission: 'quotes.quotations.view' },
    ],
    dependencies: ['crm'],
  },
  {
    slug: 'partners',
    name: 'Partner Portal',
    tagline: 'Sell through your channel',
    description:
      'Give resellers and distributors their own login to register deals, track commissions and download collateral.',
    category: 'sales',
    icon: 'Handshake',
    color: 'indigo',
    service: 'partners',
    price: price(599),
    features: ['partners.accounts', 'partners.deal_registration', 'partners.commissions'],
    permissions: [
      'partners.accounts.view', 'partners.accounts.manage',
      'partners.deals.view', 'partners.deals.approve',
      'partners.commissions.view', 'partners.commissions.manage',
    ],
    nav: [
      { label: 'Partners', path: '/partners', icon: 'Handshake', permission: 'partners.accounts.view' },
      { label: 'Registered deals', path: '/partners/deals', icon: 'BadgeCheck', permission: 'partners.deals.view' },
      { label: 'Commissions', path: '/partners/commissions', icon: 'Percent', permission: 'partners.commissions.view' },
    ],
    widgets: [],
    dependencies: ['crm'],
    status: 'coming_soon',
  },

  // ══════════════════════════════════════════════════════════════ MARKETING
  {
    slug: 'marketing',
    name: 'Marketing',
    tagline: 'Campaigns that fill the pipeline',
    description:
      'Email campaigns, audience segments, landing pages and attribution that ties spend back to closed revenue.',
    category: 'marketing',
    icon: 'Megaphone',
    color: 'pink',
    service: 'marketing',
    price: price(699),
    highlights: ['Drag-drop email builder', 'Behavioural segments', 'Landing pages', 'Revenue attribution'],
    features: ['marketing.campaigns', 'marketing.segments', 'marketing.templates', 'marketing.landing', 'marketing.attribution'],
    permissions: [
      'marketing.campaigns.view', 'marketing.campaigns.create', 'marketing.campaigns.edit',
      'marketing.campaigns.delete', 'marketing.campaigns.send',
      'marketing.segments.view', 'marketing.segments.manage',
      'marketing.reports.view',
    ],
    nav: [
      { label: 'Campaigns', path: '/marketing', icon: 'Send', permission: 'marketing.campaigns.view' },
      { label: 'Audiences', path: '/marketing/audiences', icon: 'UsersRound', permission: 'marketing.segments.view' },
      { label: 'Templates', path: '/marketing/templates', icon: 'LayoutTemplate', permission: 'marketing.campaigns.edit' },
      { label: 'Performance', path: '/marketing/performance', icon: 'ChartLine', permission: 'marketing.reports.view' },
    ],
    widgets: [
      { id: 'marketing.campaign_perf', title: 'Campaign performance', size: 'lg', permission: 'marketing.reports.view' },
      { id: 'marketing.new_leads', title: 'Leads this month', size: 'sm', permission: 'marketing.reports.view' },
    ],
    dependencies: ['crm'],
  },
  {
    slug: 'social',
    name: 'Social',
    tagline: 'One inbox for every channel',
    description:
      'Schedule posts, monitor mentions and reply across your social accounts without leaving the workspace.',
    category: 'marketing',
    icon: 'AtSign',
    color: 'pink',
    service: 'social',
    price: price(399),
    features: ['social.scheduling', 'social.inbox', 'social.listening'],
    permissions: [
      'social.posts.view', 'social.posts.create', 'social.posts.publish',
      'social.inbox.view', 'social.inbox.reply', 'social.accounts.manage',
    ],
    nav: [
      { label: 'Calendar', path: '/social', icon: 'CalendarDays', permission: 'social.posts.view' },
      { label: 'Inbox', path: '/social/inbox', icon: 'Inbox', permission: 'social.inbox.view' },
    ],
    widgets: [],
    dependencies: [],
    status: 'coming_soon',
  },
  {
    slug: 'surveys',
    name: 'Surveys & Forms',
    tagline: 'Ask, and actually use the answers',
    description:
      'Build forms and surveys, embed them anywhere, and route every response into the app that should act on it.',
    category: 'marketing',
    icon: 'ClipboardList',
    color: 'pink',
    service: 'surveys',
    price: price(299),
    highlights: ['Drag-drop builder', 'Conditional logic', 'Embed anywhere', 'Routes into CRM & Helpdesk'],
    features: ['surveys.builder', 'surveys.responses', 'surveys.logic', 'surveys.routing'],
    permissions: [
      'surveys.forms.view', 'surveys.forms.create', 'surveys.forms.edit', 'surveys.forms.delete',
      'surveys.responses.view', 'surveys.responses.export',
    ],
    nav: [
      { label: 'Forms', path: '/surveys', icon: 'ClipboardList', permission: 'surveys.forms.view' },
      { label: 'Responses', path: '/surveys/responses', icon: 'MessageSquareReply', permission: 'surveys.responses.view' },
    ],
    widgets: [{ id: 'surveys.recent', title: 'Recent responses', size: 'md', permission: 'surveys.responses.view' }],
    dependencies: [],
  },

  // ═══════════════════════════════════════════════════════════════ COMMERCE
  {
    slug: 'ecommerce',
    name: 'Online Store',
    tagline: 'Your storefront, wired to your stock',
    description:
      'A storefront that shares the same products, prices and inventory as the rest of your workspace. No syncing, no drift.',
    category: 'commerce',
    icon: 'ShoppingBag',
    color: 'rose',
    service: 'ecommerce',
    price: price(1199),
    flagship: true,
    highlights: ['Live inventory', 'Payment gateways', 'Abandoned-cart recovery', 'SEO-ready pages'],
    features: ['ecommerce.catalogue', 'ecommerce.cart', 'ecommerce.checkout', 'ecommerce.promotions', 'ecommerce.seo'],
    permissions: [
      'ecommerce.store.view', 'ecommerce.store.manage',
      'ecommerce.orders.view', 'ecommerce.orders.edit', 'ecommerce.orders.fulfil',
      'ecommerce.promotions.view', 'ecommerce.promotions.manage',
    ],
    nav: [
      { label: 'Storefront', path: '/ecommerce', icon: 'Store', permission: 'ecommerce.store.view' },
      { label: 'Online orders', path: '/ecommerce/orders', icon: 'Package', permission: 'ecommerce.orders.view' },
      { label: 'Promotions', path: '/ecommerce/promotions', icon: 'Tag', permission: 'ecommerce.promotions.view' },
    ],
    widgets: [
      { id: 'ecommerce.revenue', title: 'Online revenue', size: 'sm', permission: 'ecommerce.orders.view' },
      { id: 'ecommerce.orders_today', title: 'Orders today', size: 'sm', permission: 'ecommerce.orders.view' },
    ],
    dependencies: ['erp'],
  },
  {
    slug: 'pos',
    name: 'Point of Sale',
    tagline: 'Counter sales that keep working offline',
    description:
      'A fast touch till for shops and counters. Keeps selling when the internet drops and reconciles stock the moment it returns.',
    category: 'commerce',
    icon: 'Calculator',
    color: 'rose',
    service: 'pos',
    price: price(899),
    highlights: ['Works offline', 'Barcode & scale ready', 'Split payments', 'Shift cash-up'],
    features: ['pos.registers', 'pos.sessions', 'pos.payments', 'pos.offline'],
    permissions: [
      'pos.registers.view', 'pos.registers.manage',
      'pos.sessions.open', 'pos.sessions.close', 'pos.sessions.view',
      'pos.sales.create', 'pos.sales.refund', 'pos.reports.view',
    ],
    nav: [
      { label: 'Registers', path: '/pos', icon: 'Calculator', permission: 'pos.registers.view' },
      { label: 'Sessions', path: '/pos/sessions', icon: 'ClipboardCheck', permission: 'pos.sessions.view' },
      { label: 'Sales', path: '/pos/sales', icon: 'ReceiptIndianRupee', permission: 'pos.reports.view' },
    ],
    widgets: [{ id: 'pos.today', title: 'Counter sales today', size: 'sm', permission: 'pos.reports.view' }],
    dependencies: ['erp'],
  },
  {
    slug: 'recurring',
    name: 'Recurring Billing',
    tagline: 'Recurring revenue, handled',
    description:
      'Plans, trials, upgrades, dunning and churn metrics for any business that bills on a cycle.',
    category: 'commerce',
    icon: 'RefreshCw',
    color: 'rose',
    service: 'recurring',
    price: price(799),
    features: ['recurring.plans', 'recurring.lifecycle', 'recurring.dunning', 'recurring.metrics'],
    permissions: [
      'recurring.plans.view', 'recurring.plans.manage',
      'recurring.customers.view', 'recurring.customers.manage',
      'recurring.reports.view',
    ],
    nav: [
      { label: 'Subscribers', path: '/recurring', icon: 'RefreshCw', permission: 'recurring.customers.view' },
      { label: 'Plans', path: '/recurring/plans', icon: 'LayersIcon', permission: 'recurring.plans.view' },
      { label: 'Revenue', path: '/recurring/revenue', icon: 'ChartLine', permission: 'recurring.reports.view' },
    ],
    widgets: [{ id: 'recurring.mrr', title: 'Monthly recurring revenue', size: 'sm', permission: 'recurring.reports.view' }],
    dependencies: ['invoicing'],
    status: 'coming_soon',
  },

  // ════════════════════════════════════════════════════════════════ SERVICE
  {
    slug: 'helpdesk',
    name: 'Helpdesk',
    tagline: 'Every customer issue, answered',
    description:
      'Tickets, teams, agents, SLAs, canned responses and a customer portal — connected to the same customers your CRM already knows.',
    category: 'service',
    icon: 'Headphones',
    color: 'orange',
    service: 'helpdesk',
    price: price(699),
    flagship: true,
    highlights: ['SLA tracking', 'Customer portal', 'Canned responses', 'Satisfaction scores'],
    features: ['helpdesk.tickets', 'helpdesk.teams', 'helpdesk.sla', 'helpdesk.portal', 'helpdesk.canned'],
    permissions: [
      'helpdesk.tickets.view', 'helpdesk.tickets.create', 'helpdesk.tickets.edit',
      'helpdesk.tickets.delete', 'helpdesk.tickets.assign',
      'helpdesk.teams.view', 'helpdesk.teams.manage', 'helpdesk.sla.manage', 'helpdesk.reports.view',
    ],
    nav: [
      { label: 'Overview', path: '/helpdesk', icon: 'LayoutDashboard', permission: 'helpdesk.tickets.view' },
      { label: 'Tickets', path: '/helpdesk/tickets', icon: 'Ticket', permission: 'helpdesk.tickets.view' },
      { label: 'My queue', path: '/helpdesk/queue', icon: 'Inbox', permission: 'helpdesk.tickets.view' },
      { label: 'Teams', path: '/helpdesk/teams', icon: 'Users', permission: 'helpdesk.teams.view' },
      { label: 'SLA policies', path: '/helpdesk/sla', icon: 'Timer', permission: 'helpdesk.sla.manage' },
    ],
    widgets: [
      { id: 'helpdesk.open_tickets', title: 'Open tickets', size: 'sm', permission: 'helpdesk.tickets.view' },
      { id: 'helpdesk.sla_risk', title: 'SLA at risk', size: 'sm', permission: 'helpdesk.tickets.view' },
      { id: 'helpdesk.csat', title: 'Satisfaction', size: 'sm', permission: 'helpdesk.reports.view' },
      { id: 'helpdesk.volume', title: 'Ticket volume', size: 'lg', permission: 'helpdesk.reports.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'fieldservice',
    name: 'Field Service',
    tagline: 'Dispatch, track, close the job',
    description:
      'Schedule engineers, route them efficiently, capture proof of work on site and bill the visit automatically.',
    category: 'service',
    icon: 'Truck',
    color: 'orange',
    service: 'fieldservice',
    price: price(999),
    highlights: ['Drag-drop dispatch board', 'Mobile job sheets', 'Parts consumption', 'Auto-billing'],
    features: ['fieldservice.jobs', 'fieldservice.scheduling', 'fieldservice.mobile', 'fieldservice.parts'],
    permissions: [
      'fieldservice.jobs.view', 'fieldservice.jobs.create', 'fieldservice.jobs.edit',
      'fieldservice.jobs.assign', 'fieldservice.jobs.complete', 'fieldservice.reports.view',
    ],
    nav: [
      { label: 'Dispatch', path: '/fieldservice', icon: 'MapPinned', permission: 'fieldservice.jobs.view' },
      { label: 'Jobs', path: '/fieldservice/jobs', icon: 'Wrench', permission: 'fieldservice.jobs.view' },
    ],
    widgets: [{ id: 'fieldservice.today', title: 'Jobs today', size: 'sm', permission: 'fieldservice.jobs.view' }],
    dependencies: ['helpdesk'],
    status: 'coming_soon',
  },
  {
    slug: 'knowledge',
    name: 'Knowledge Base',
    tagline: 'The answers, written down once',
    description: 'Spaces, articles, categories, an internal wiki and a public help centre.',
    category: 'service',
    icon: 'BookMarked',
    color: 'orange',
    service: 'knowledge',
    price: price(299),
    highlights: ['Internal wiki', 'Public help centre', 'Full-text search', 'Article analytics'],
    features: ['knowledge.spaces', 'knowledge.articles', 'knowledge.public', 'knowledge.search'],
    permissions: [
      'knowledge.articles.view', 'knowledge.articles.create', 'knowledge.articles.edit',
      'knowledge.articles.delete', 'knowledge.articles.publish', 'knowledge.spaces.manage',
    ],
    nav: [
      { label: 'Spaces', path: '/knowledge', icon: 'Library', permission: 'knowledge.articles.view' },
      { label: 'Articles', path: '/knowledge/articles', icon: 'FileType', permission: 'knowledge.articles.view' },
    ],
    widgets: [{ id: 'knowledge.recent', title: 'Recently updated', size: 'md', permission: 'knowledge.articles.view' }],
    dependencies: [],
  },

  // ════════════════════════════════════════════════════════════════ FINANCE
  {
    slug: 'invoicing',
    name: 'Invoicing',
    tagline: 'Get paid, on time',
    description:
      'Invoices, recurring billing, payments, credit notes and GST-ready tax handling, with reminders that chase for you.',
    category: 'finance',
    icon: 'FileText',
    color: 'sky',
    service: 'invoicing',
    price: price(599),
    flagship: true,
    highlights: ['GST-ready', 'Recurring invoices', 'Payment links', 'Automatic reminders'],
    features: ['invoicing.invoices', 'invoicing.recurring', 'invoicing.payments', 'invoicing.taxes', 'invoicing.reminders'],
    permissions: [
      'invoicing.invoices.view', 'invoicing.invoices.create', 'invoicing.invoices.edit',
      'invoicing.invoices.delete', 'invoicing.invoices.send',
      'invoicing.payments.view', 'invoicing.payments.record',
      'invoicing.reports.view',
    ],
    nav: [
      { label: 'Overview', path: '/invoicing', icon: 'LayoutDashboard', permission: 'invoicing.invoices.view' },
      { label: 'Invoices', path: '/invoicing/invoices', icon: 'FileText', permission: 'invoicing.invoices.view' },
      { label: 'Design', path: '/invoicing/templates', icon: 'Palette', permission: 'invoicing.invoices.view' },
    ],
    widgets: [
      { id: 'invoicing.outstanding', title: 'Outstanding', size: 'sm', permission: 'invoicing.invoices.view' },
      { id: 'invoicing.overdue', title: 'Overdue', size: 'sm', permission: 'invoicing.invoices.view' },
      { id: 'invoicing.collected', title: 'Collected this month', size: 'sm', permission: 'invoicing.payments.view' },
      { id: 'invoicing.ageing', title: 'Receivables ageing', size: 'lg', permission: 'invoicing.reports.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'accounting',
    name: 'Accounting',
    tagline: 'A real general ledger, not a spreadsheet',
    description:
      'Chart of accounts, journal entries, ledgers, receivables, payables, bank and cash, P&L, balance sheet and trial balance — fed automatically by sales, purchase and invoicing.',
    category: 'finance',
    icon: 'Landmark',
    color: 'cyan',
    service: 'accounting',
    price: price(1299),
    flagship: true,
    highlights: ['Double-entry ledger', 'Auto-posting from other apps', 'P&L and balance sheet', 'Bank reconciliation'],
    features: ['accounting.coa', 'accounting.journals', 'accounting.ledger', 'accounting.ar', 'accounting.ap', 'accounting.bank', 'accounting.reports'],
    permissions: [
      'accounting.coa.view', 'accounting.coa.manage',
      'accounting.journal.view', 'accounting.journal.post', 'accounting.journal.delete',
      'accounting.ledger.view', 'accounting.bank.view', 'accounting.bank.reconcile',
      'accounting.reports.view', 'accounting.reports.export',
    ],
    nav: [
      { label: 'Overview', path: '/accounting', icon: 'LayoutDashboard', permission: 'accounting.ledger.view' },
      { label: 'Chart of accounts', path: '/accounting/accounts', icon: 'ListTree', permission: 'accounting.coa.view' },
      { label: 'Journal entries', path: '/accounting/journal', icon: 'BookOpen', permission: 'accounting.journal.view' },
      { label: 'Banking', path: '/accounting/bank', icon: 'Landmark', permission: 'accounting.bank.view' },
      { label: 'Reports', path: '/accounting/reports', icon: 'FileBarChart', permission: 'accounting.reports.view' },
    ],
    widgets: [
      { id: 'accounting.cash_position', title: 'Cash position', size: 'sm', permission: 'accounting.bank.view' },
      { id: 'accounting.pnl', title: 'Profit & loss', size: 'lg', permission: 'accounting.reports.view' },
    ],
    dependencies: ['invoicing'],
  },
  {
    slug: 'expenses',
    name: 'Expenses',
    tagline: 'Claims without the paper chase',
    description:
      'Snap a receipt, submit a claim, get it approved and reimbursed — posted straight to the ledger.',
    category: 'finance',
    icon: 'ReceiptIndianRupee',
    color: 'cyan',
    service: 'expenses',
    price: price(299),
    highlights: ['Receipt capture', 'Approval chains', 'Mileage & per-diem', 'Posts to accounting'],
    features: ['expenses.claims', 'expenses.approvals', 'expenses.policies', 'expenses.reimbursement'],
    permissions: [
      'expenses.claims.view', 'expenses.claims.create', 'expenses.claims.edit',
      'expenses.claims.approve', 'expenses.claims.reimburse', 'expenses.policies.manage',
    ],
    nav: [
      { label: 'My claims', path: '/expenses', icon: 'ReceiptIndianRupee', permission: 'expenses.claims.view' },
      { label: 'To approve', path: '/expenses/approvals', icon: 'CheckCheck', permission: 'expenses.claims.approve' },
      { label: 'Policies', path: '/expenses/policies', icon: 'Scale', permission: 'expenses.policies.manage' },
    ],
    widgets: [
      { id: 'expenses.pending', title: 'Claims to approve', size: 'sm', permission: 'expenses.claims.approve' },
      { id: 'expenses.mine', title: 'My open claims', size: 'md', permission: 'expenses.claims.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'assets',
    name: 'Asset Management',
    tagline: 'Know what you own and what it is worth',
    description:
      'Track fixed assets, run depreciation schedules, record disposals and keep the book value honest.',
    category: 'finance',
    icon: 'Building',
    color: 'cyan',
    service: 'assets',
    price: price(399),
    features: ['assets.register', 'assets.depreciation', 'assets.disposal'],
    permissions: [
      'assets.register.view', 'assets.register.manage',
      'assets.depreciation.run', 'assets.reports.view',
    ],
    nav: [
      { label: 'Asset register', path: '/assets', icon: 'Building', permission: 'assets.register.view' },
      { label: 'Depreciation', path: '/assets/depreciation', icon: 'ChartLine', permission: 'assets.reports.view' },
    ],
    widgets: [],
    dependencies: ['accounting'],
    status: 'coming_soon',
  },

  // ═════════════════════════════════════════════════════════════ OPERATIONS
  {
    slug: 'erp',
    name: 'Inventory & Purchasing',
    tagline: 'Products, stock and suppliers',
    description:
      'Products, categories, multi-warehouse stock, purchase orders, vendors, transfers and adjustments. The system of record for what you sell and hold.',
    category: 'operations',
    icon: 'Boxes',
    color: 'amber',
    service: 'erp',
    price: price(999),
    flagship: true,
    highlights: ['Multi-warehouse', 'Purchase orders', 'Stock valuation', 'Low-stock alerts'],
    features: ['erp.products', 'erp.inventory', 'erp.warehouses', 'erp.purchase', 'erp.vendors', 'erp.transfers'],
    permissions: [
      'erp.products.view', 'erp.products.create', 'erp.products.edit', 'erp.products.delete',
      'erp.inventory.view', 'erp.inventory.adjust',
      'erp.warehouses.view', 'erp.warehouses.manage',
      'erp.purchase.view', 'erp.purchase.create', 'erp.purchase.approve',
      'erp.vendors.view', 'erp.vendors.manage',
      'erp.reports.view',
    ],
    nav: [
      { label: 'Overview', path: '/erp', icon: 'LayoutDashboard', permission: 'erp.inventory.view' },
      { label: 'Products', path: '/erp/products', icon: 'Package', permission: 'erp.products.view' },
      { label: 'Stock', path: '/erp/stock', icon: 'Warehouse', permission: 'erp.inventory.view' },
      { label: 'Purchase orders', path: '/erp/purchase', icon: 'ShoppingCart', permission: 'erp.purchase.view' },
      { label: 'Vendors', path: '/erp/vendors', icon: 'Truck', permission: 'erp.vendors.view' },
    ],
    widgets: [
      { id: 'erp.stock_value', title: 'Stock value', size: 'sm', permission: 'erp.inventory.view' },
      { id: 'erp.low_stock', title: 'Low stock', size: 'md', permission: 'erp.inventory.view' },
      { id: 'erp.open_pos', title: 'Open purchase orders', size: 'md', permission: 'erp.purchase.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'manufacturing',
    name: 'Manufacturing',
    tagline: 'From bill of materials to finished goods',
    description:
      'Bills of materials, manufacturing orders, work centers, production planning, material consumption, scrap and quality.',
    category: 'operations',
    icon: 'Factory',
    color: 'amber',
    service: 'manufacturing',
    price: price(1499),
    highlights: ['Multi-level BOMs', 'Work-centre capacity', 'Material backflush', 'Scrap & yield'],
    features: ['mfg.bom', 'mfg.orders', 'mfg.workcenters', 'mfg.planning', 'mfg.quality'],
    permissions: [
      'manufacturing.bom.view', 'manufacturing.bom.manage',
      'manufacturing.orders.view', 'manufacturing.orders.create', 'manufacturing.orders.edit',
      'manufacturing.workcenters.view', 'manufacturing.workcenters.manage',
      'manufacturing.reports.view',
    ],
    nav: [
      { label: 'Manufacturing orders', path: '/manufacturing', icon: 'ClipboardList', permission: 'manufacturing.orders.view' },
      { label: 'Bills of materials', path: '/manufacturing/bom', icon: 'GitFork', permission: 'manufacturing.bom.view' },
      { label: 'Work centers', path: '/manufacturing/work-centers', icon: 'Cog', permission: 'manufacturing.workcenters.view' },
      { label: 'Planning', path: '/manufacturing/planning', icon: 'CalendarRange', permission: 'manufacturing.orders.view' },
    ],
    widgets: [{ id: 'mfg.in_production', title: 'In production', size: 'md', permission: 'manufacturing.orders.view' }],
    dependencies: ['erp'],
  },
  {
    slug: 'quality',
    name: 'Quality',
    tagline: 'Catch it before the customer does',
    description:
      'Inspection plans, checkpoints on receipt and production, non-conformance reports and corrective actions.',
    category: 'operations',
    icon: 'BadgeCheck',
    color: 'amber',
    service: 'quality',
    price: price(499),
    features: ['quality.plans', 'quality.checks', 'quality.ncr', 'quality.capa'],
    permissions: [
      'quality.checks.view', 'quality.checks.perform',
      'quality.ncr.view', 'quality.ncr.create', 'quality.ncr.close',
      'quality.plans.manage',
    ],
    nav: [
      { label: 'Checks', path: '/quality', icon: 'BadgeCheck', permission: 'quality.checks.view' },
      { label: 'Non-conformance', path: '/quality/ncr', icon: 'TriangleAlert', permission: 'quality.ncr.view' },
    ],
    widgets: [],
    dependencies: ['erp'],
    status: 'coming_soon',
  },
  {
    slug: 'maintenance',
    name: 'Maintenance',
    tagline: 'Keep the machines running',
    description:
      'Preventive schedules, breakdown requests, spare-part consumption and downtime reporting for your equipment.',
    category: 'operations',
    icon: 'Wrench',
    color: 'amber',
    service: 'maintenance',
    price: price(499),
    features: ['maintenance.equipment', 'maintenance.preventive', 'maintenance.requests'],
    permissions: [
      'maintenance.equipment.view', 'maintenance.equipment.manage',
      'maintenance.requests.view', 'maintenance.requests.create', 'maintenance.requests.close',
    ],
    nav: [
      { label: 'Equipment', path: '/maintenance', icon: 'Wrench', permission: 'maintenance.equipment.view' },
      { label: 'Requests', path: '/maintenance/requests', icon: 'TriangleAlert', permission: 'maintenance.requests.view' },
    ],
    widgets: [],
    dependencies: [],
    status: 'coming_soon',
  },

  // ═════════════════════════════════════════════════════════════════ PEOPLE
  {
    slug: 'hr',
    name: 'HR',
    tagline: 'Your whole team, from offer letter to exit',
    description:
      'Employee records, departments, attendance, leave, documents, performance and onboarding — the system of record for your people.',
    category: 'people',
    icon: 'UsersRound',
    color: 'emerald',
    service: 'hr',
    price: price(599),
    flagship: true,
    highlights: ['Shifts & overtime', 'Biometric punch sync', 'Employee self-service', 'Offer letters & reviews'],
    features: ['hr.employees', 'hr.departments', 'hr.attendance', 'hr.shifts', 'hr.devices', 'hr.leave', 'hr.documents', 'hr.performance', 'hr.assets', 'hr.onboarding'],
    permissions: [
      'hr.employees.view', 'hr.employees.create', 'hr.employees.edit', 'hr.employees.delete', 'hr.employees.export',
      'hr.departments.view', 'hr.departments.manage',
      'hr.attendance.view', 'hr.attendance.edit', 'hr.attendance.approve',
      'hr.shifts.view', 'hr.shifts.manage',
      'hr.devices.view', 'hr.devices.manage',
      'hr.leave.view', 'hr.leave.create', 'hr.leave.approve',
      'hr.documents.view', 'hr.documents.manage',
      'hr.performance.view', 'hr.performance.manage', 'hr.performance.review',
      // The employee portal. Every one of these resolves the person from the
      // signed-in user, never from an id in the request.
      'hr.self.view', 'hr.self.attendance', 'hr.self.leave', 'hr.self.documents',
      'hr.self.performance',
      'hr.assets.view', 'hr.assets.manage',
    ],
    nav: [
      { label: 'Overview', path: '/hr', icon: 'LayoutDashboard', permission: 'hr.employees.view' },
      { label: 'Employees', path: '/hr/employees', icon: 'UserRound', permission: 'hr.employees.view' },
      { label: 'Departments', path: '/hr/departments', icon: 'Network', permission: 'hr.departments.view' },
      { label: 'Attendance', path: '/hr/attendance', icon: 'Clock', permission: 'hr.attendance.view' },
      { label: 'Shifts', path: '/hr/shifts', icon: 'CalendarClock', permission: 'hr.shifts.view' },
      { label: 'Devices', path: '/hr/devices', icon: 'Fingerprint', permission: 'hr.devices.view' },
      { label: 'Leave', path: '/hr/leave', icon: 'CalendarOff', permission: 'hr.leave.view' },
      { label: 'Performance', path: '/hr/performance', icon: 'Target', permission: 'hr.performance.view' },
      { label: 'Documents', path: '/hr/documents', icon: 'FileSignature', permission: 'hr.documents.view' },
    ],
    widgets: [
      { id: 'hr.headcount', title: 'Headcount', size: 'sm', permission: 'hr.employees.view' },
      { id: 'hr.present_today', title: 'Present today', size: 'sm', permission: 'hr.attendance.view' },
      { id: 'hr.on_leave', title: 'On leave', size: 'sm', permission: 'hr.leave.view' },
      { id: 'hr.pending_leave', title: 'Leave approvals', size: 'md', permission: 'hr.leave.approve' },
      { id: 'hr.anniversaries', title: 'Birthdays & anniversaries', size: 'md', permission: 'hr.employees.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'payroll',
    name: 'Payroll',
    tagline: 'Salaries, statutory and payslips',
    description:
      'Salary structures, payroll runs, PF/ESI/TDS, payslips and the compliance reports that go with them.',
    category: 'people',
    icon: 'BadgeIndianRupee',
    color: 'emerald',
    service: 'payroll',
    price: price(499),
    highlights: ['PF, ESI & TDS', 'Payslip portal', 'Arrears & bonuses', 'Posts to accounting'],
    features: ['payroll.structures', 'payroll.runs', 'payroll.payslips', 'payroll.statutory'],
    permissions: [
      'payroll.runs.view', 'payroll.runs.create', 'payroll.runs.approve',
      'payroll.structures.view', 'payroll.structures.manage',
      'payroll.payslips.view', 'payroll.reports.view',
      // Their own payslips, and only once the run is approved.
      'payroll.self.payslips',
    ],
    nav: [
      { label: 'Payroll runs', path: '/payroll', icon: 'BadgeIndianRupee', permission: 'payroll.runs.view' },
      { label: 'Salary structures', path: '/payroll/structures', icon: 'Scale', permission: 'payroll.structures.view' },
      { label: 'Payslips', path: '/payroll/payslips', icon: 'Receipt', permission: 'payroll.payslips.view' },
    ],
    widgets: [{ id: 'payroll.next_run', title: 'Next payroll run', size: 'md', permission: 'payroll.runs.view' }],
    dependencies: ['hr'],
  },
  {
    slug: 'recruitment',
    name: 'Recruitment',
    tagline: 'From job post to joining date',
    description:
      'Job postings, a candidate pipeline, interview scheduling, scorecards and offers that become employees in one click.',
    category: 'people',
    icon: 'UserPlus',
    color: 'emerald',
    service: 'recruitment',
    price: price(599),
    highlights: ['Careers page', 'Kanban candidate pipeline', 'Interview scorecards', 'One-click hire'],
    features: ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews', 'recruitment.offers'],
    permissions: [
      'recruitment.jobs.view', 'recruitment.jobs.manage',
      'recruitment.candidates.view', 'recruitment.candidates.edit', 'recruitment.candidates.advance',
      'recruitment.offers.view', 'recruitment.offers.approve',
    ],
    nav: [
      { label: 'Pipeline', path: '/recruitment', icon: 'Kanban', permission: 'recruitment.candidates.view' },
      { label: 'Job postings', path: '/recruitment/jobs', icon: 'Briefcase', permission: 'recruitment.jobs.view' },
      { label: 'Offers', path: '/recruitment/offers', icon: 'FileSignature', permission: 'recruitment.offers.view' },
    ],
    widgets: [{ id: 'recruitment.open_roles', title: 'Open roles', size: 'sm', permission: 'recruitment.jobs.view' }],
    dependencies: ['hr'],
  },
  {
    slug: 'learning',
    name: 'Learning',
    tagline: 'Train the team, prove the training',
    description:
      'Courses, learning paths, quizzes and completion records — including the compliance training you have to evidence.',
    category: 'people',
    icon: 'GraduationCap',
    color: 'emerald',
    service: 'learning',
    price: price(399),
    features: ['learning.courses', 'learning.paths', 'learning.quizzes', 'learning.certificates'],
    permissions: [
      'learning.courses.view', 'learning.courses.manage',
      'learning.enrolments.view', 'learning.enrolments.manage', 'learning.reports.view',
    ],
    nav: [
      { label: 'Courses', path: '/learning', icon: 'GraduationCap', permission: 'learning.courses.view' },
      { label: 'My learning', path: '/learning/mine', icon: 'BookOpenCheck', permission: 'learning.courses.view' },
    ],
    widgets: [],
    dependencies: ['hr'],
    status: 'coming_soon',
  },

  // ═══════════════════════════════════════════════════════════════ PROJECTS
  {
    slug: 'tasks',
    name: 'Projects & Tasks',
    tagline: 'Everything the team is working on',
    description:
      'Projects, tasks, subtasks, kanban boards, milestones and time tracking — with tasks that can be raised from any other app.',
    category: 'projects',
    icon: 'ListChecks',
    color: 'violet',
    service: 'tasks',
    price: price(399),
    flagship: true,
    highlights: ['Kanban & list views', 'Time tracking', 'Milestones', 'Cross-app tasks'],
    features: ['tasks.projects', 'tasks.tasks', 'tasks.kanban', 'tasks.timetracking', 'tasks.milestones'],
    permissions: [
      'tasks.projects.view', 'tasks.projects.create', 'tasks.projects.edit', 'tasks.projects.delete',
      'tasks.tasks.view', 'tasks.tasks.create', 'tasks.tasks.edit', 'tasks.tasks.delete', 'tasks.tasks.assign',
      'tasks.time.view', 'tasks.time.log',
    ],
    nav: [
      { label: 'My work', path: '/tasks', icon: 'CircleDot', permission: 'tasks.tasks.view' },
      { label: 'Projects', path: '/tasks/projects', icon: 'FolderKanban', permission: 'tasks.projects.view' },
      { label: 'Board', path: '/tasks/board', icon: 'Kanban', permission: 'tasks.tasks.view' },
      { label: 'Calendar', path: '/tasks/calendar', icon: 'CalendarDays', permission: 'tasks.tasks.view' },
      { label: 'Timesheets', path: '/tasks/time', icon: 'Timer', permission: 'tasks.time.view' },
    ],
    widgets: [
      { id: 'tasks.my_open', title: 'My open tasks', size: 'md', permission: 'tasks.tasks.view' },
      { id: 'tasks.overdue', title: 'Overdue', size: 'sm', permission: 'tasks.tasks.view' },
      { id: 'tasks.project_health', title: 'Project health', size: 'lg', permission: 'tasks.projects.view' },
    ],
    dependencies: [],
  },
  {
    slug: 'planning',
    name: 'Resource Planning',
    tagline: 'Who is free, and when',
    description:
      'Capacity planning, Gantt timelines and workload balancing across every project and person.',
    category: 'projects',
    icon: 'CalendarRange',
    color: 'violet',
    service: 'planning',
    price: price(499),
    highlights: ['Gantt timeline', 'Capacity heatmap', 'Skill matching', 'Over-allocation alerts'],
    features: ['planning.gantt', 'planning.capacity', 'planning.allocation'],
    permissions: [
      'planning.schedule.view', 'planning.schedule.manage',
      'planning.capacity.view', 'planning.reports.view',
    ],
    nav: [
      { label: 'Timeline', path: '/planning', icon: 'CalendarRange', permission: 'planning.schedule.view' },
      { label: 'Capacity', path: '/planning/capacity', icon: 'Gauge', permission: 'planning.capacity.view' },
    ],
    widgets: [{ id: 'planning.utilisation', title: 'Team utilisation', size: 'md', permission: 'planning.capacity.view' }],
    dependencies: ['tasks'],
  },

  // ══════════════════════════════════════════════════════════ COLLABORATION
  {
    slug: 'documents',
    name: 'Documents',
    tagline: 'One place for every file',
    description: 'Folders, sharing, permissions, version history, comments and approval workflows.',
    category: 'collaboration',
    icon: 'FolderOpen',
    color: 'blue',
    service: 'documents',
    price: price(299),
    flagship: true,
    highlights: ['Version history', 'Granular sharing', 'Approvals', 'Attach from any app'],
    features: ['documents.folders', 'documents.sharing', 'documents.versions', 'documents.approval'],
    permissions: [
      'documents.files.view', 'documents.files.upload', 'documents.files.edit',
      'documents.files.delete', 'documents.files.share', 'documents.folders.manage',
    ],
    nav: [
      { label: 'All files', path: '/documents', icon: 'FolderOpen', permission: 'documents.files.view' },
    ],
    widgets: [{ id: 'documents.recent', title: 'Recent files', size: 'md', permission: 'documents.files.view' }],
    dependencies: [],
  },
  {
    slug: 'mail',
    name: 'Mail',
    tagline: 'Business email on your own domain',
    description:
      'Hosted mailboxes for your team, with every message linkable to the customer, deal or ticket it belongs to.',
    category: 'collaboration',
    icon: 'Mail',
    color: 'blue',
    service: 'mail',
    price: price(199),
    highlights: ['Your own domain', 'Shared inboxes', 'Link mail to records', 'No ads, ever'],
    features: ['mail.mailboxes', 'mail.shared', 'mail.rules', 'mail.linking'],
    permissions: [
      'mail.mailbox.view', 'mail.mailbox.send',
      'mail.shared.view', 'mail.shared.manage', 'mail.domains.manage',
    ],
    nav: [
      { label: 'Inbox', path: '/mail', icon: 'Mail', permission: 'mail.mailbox.view' },
      { label: 'Shared inboxes', path: '/mail/shared', icon: 'Users', permission: 'mail.shared.view' },
    ],
    widgets: [],
    dependencies: [],
    status: 'coming_soon',
  },
  {
    slug: 'discuss',
    name: 'Discuss',
    tagline: 'Team chat that knows your records',
    description: 'Channels, direct messages, mentions and attachments — threaded against the records you work on.',
    category: 'collaboration',
    icon: 'MessagesSquare',
    color: 'blue',
    service: 'discuss',
    price: price(199),
    features: ['discuss.channels', 'discuss.dm', 'discuss.mentions'],
    permissions: ['discuss.channels.view', 'discuss.channels.create', 'discuss.messages.send'],
    nav: [{ label: 'Chat', path: '/discuss', icon: 'MessageCircle', permission: 'discuss.channels.view' }],
    widgets: [],
    dependencies: [],
    status: 'coming_soon',
  },
  {
    slug: 'meetings',
    name: 'Calendar & Meetings',
    tagline: 'Shared calendars and booking pages',
    description:
      'Team calendars, resource booking, and public scheduling pages so customers can book time without the email ping-pong.',
    category: 'collaboration',
    icon: 'CalendarCheck',
    color: 'blue',
    service: 'meetings',
    price: price(249),
    features: ['meetings.calendars', 'meetings.booking', 'meetings.resources'],
    permissions: [
      'meetings.calendar.view', 'meetings.calendar.manage',
      'meetings.booking.view', 'meetings.booking.manage',
    ],
    nav: [
      { label: 'Calendar', path: '/meetings', icon: 'CalendarCheck', permission: 'meetings.calendar.view' },
      { label: 'Booking pages', path: '/meetings/booking', icon: 'Link2', permission: 'meetings.booking.view' },
    ],
    widgets: [{ id: 'meetings.today', title: 'Today’s meetings', size: 'md', permission: 'meetings.calendar.view' }],
    dependencies: [],
    status: 'coming_soon',
  },
  {
    slug: 'sign',
    name: 'E-Signature',
    tagline: 'Signed, sealed, audited',
    description:
      'Send documents for legally binding electronic signature, with reminders and a tamper-evident audit trail.',
    category: 'collaboration',
    icon: 'PenLine',
    color: 'blue',
    service: 'sign',
    price: price(349),
    highlights: ['Legally binding', 'Audit trail', 'Reminders', 'Templates & fields'],
    features: ['sign.envelopes', 'sign.templates', 'sign.audit'],
    permissions: [
      'sign.envelopes.view', 'sign.envelopes.send', 'sign.envelopes.void', 'sign.templates.manage',
    ],
    nav: [
      { label: 'Envelopes', path: '/sign', icon: 'PenLine', permission: 'sign.envelopes.view' },
      { label: 'Templates', path: '/sign/templates', icon: 'LayoutTemplate', permission: 'sign.templates.manage' },
    ],
    widgets: [{ id: 'sign.awaiting', title: 'Awaiting signature', size: 'sm', permission: 'sign.envelopes.view' }],
    dependencies: ['documents'],
  },

  // ══════════════════════════════════════════════════════════════════ LEGAL
  {
    slug: 'contracts',
    name: 'Contracts',
    tagline: 'Never miss a renewal again',
    description:
      'A contract repository with clause libraries, obligation tracking, renewal alerts and approval workflows.',
    category: 'legal',
    icon: 'Scale',
    color: 'slate',
    service: 'contracts',
    price: price(699),
    highlights: ['Renewal alerts', 'Clause library', 'Obligation tracking', 'Approval workflow'],
    features: ['contracts.repository', 'contracts.clauses', 'contracts.obligations', 'contracts.renewals'],
    permissions: [
      'contracts.records.view', 'contracts.records.create', 'contracts.records.edit',
      'contracts.records.approve', 'contracts.clauses.manage', 'contracts.reports.view',
    ],
    nav: [
      { label: 'Contracts', path: '/contracts', icon: 'Scale', permission: 'contracts.records.view' },
      { label: 'Renewals', path: '/contracts/renewals', icon: 'BellRing', permission: 'contracts.records.view' },
      { label: 'Clause library', path: '/contracts/clauses', icon: 'Library', permission: 'contracts.clauses.manage' },
    ],
    widgets: [{ id: 'contracts.expiring', title: 'Expiring in 90 days', size: 'md', permission: 'contracts.records.view' }],
    dependencies: ['documents'],
  },
  {
    slug: 'compliance',
    name: 'Compliance',
    tagline: 'Evidence, not hope',
    description:
      'Map controls to frameworks, assign owners, collect evidence on a schedule and stay audit-ready all year.',
    category: 'legal',
    icon: 'ShieldCheck',
    color: 'slate',
    service: 'compliance',
    price: price(899),
    features: ['compliance.frameworks', 'compliance.controls', 'compliance.evidence', 'compliance.audits'],
    permissions: [
      'compliance.controls.view', 'compliance.controls.manage',
      'compliance.evidence.view', 'compliance.evidence.upload', 'compliance.audits.view',
    ],
    nav: [
      { label: 'Controls', path: '/compliance', icon: 'ShieldCheck', permission: 'compliance.controls.view' },
      { label: 'Evidence', path: '/compliance/evidence', icon: 'FolderCheck', permission: 'compliance.evidence.view' },
    ],
    widgets: [],
    dependencies: [],
    status: 'coming_soon',
  },

  // ═══════════════════════════════════════════════════════════════ SECURITY
  {
    slug: 'iam',
    name: 'Identity & Access',
    tagline: 'SSO, MFA and who touched what',
    description:
      'SAML and OIDC single sign-on, enforced MFA, session policies and a complete, immutable audit trail of every action.',
    category: 'security',
    icon: 'KeyRound',
    color: 'teal',
    service: 'iam',
    price: price(499),
    highlights: ['SAML & OIDC SSO', 'Enforced MFA', 'Session policies', 'Immutable audit log'],
    features: ['iam.sso', 'iam.mfa', 'iam.policies', 'iam.audit'],
    permissions: [
      'iam.sso.view', 'iam.sso.manage',
      'iam.policies.view', 'iam.policies.manage',
      'iam.audit.view', 'iam.audit.export',
    ],
    nav: [
      { label: 'Single sign-on', path: '/iam', icon: 'KeyRound', permission: 'iam.sso.view' },
      { label: 'Security policies', path: '/iam/policies', icon: 'ShieldCheck', permission: 'iam.policies.view' },
      { label: 'Audit log', path: '/iam/audit', icon: 'ScrollText', permission: 'iam.audit.view' },
    ],
    widgets: [{ id: 'iam.recent_signins', title: 'Recent sign-ins', size: 'md', permission: 'iam.audit.view' }],
    dependencies: [],
  },
  {
    slug: 'devices',
    name: 'Device Management',
    tagline: 'Every laptop accounted for',
    description:
      'Enrol company devices, push policies, track who holds what, and wipe remotely when someone leaves.',
    category: 'security',
    icon: 'Laptop',
    color: 'teal',
    service: 'devices',
    price: price(399),
    features: ['devices.enrolment', 'devices.policies', 'devices.inventory'],
    permissions: [
      'devices.inventory.view', 'devices.inventory.manage',
      'devices.policies.manage', 'devices.actions.wipe',
    ],
    nav: [
      { label: 'Devices', path: '/devices', icon: 'Laptop', permission: 'devices.inventory.view' },
      { label: 'Policies', path: '/devices/policies', icon: 'ShieldCheck', permission: 'devices.policies.manage' },
    ],
    widgets: [],
    dependencies: ['hr'],
    status: 'coming_soon',
  },

  // ══════════════════════════════════════════════════════════════ ANALYTICS
  {
    slug: 'bi',
    name: 'Business Intelligence',
    tagline: 'Every app, one set of numbers',
    description:
      'Dashboards, charts, KPIs, drilldowns and scheduled reports across CRM, HR, inventory, invoicing and accounting data.',
    category: 'analytics',
    icon: 'BarChart3',
    color: 'fuchsia',
    service: 'bi',
    price: price(899),
    flagship: true,
    highlights: ['Cross-app dashboards', 'Custom KPIs', 'Scheduled email reports', 'CSV & Excel export'],
    features: ['bi.dashboards', 'bi.reports', 'bi.kpis', 'bi.scheduled', 'bi.export'],
    permissions: [
      'bi.dashboards.view', 'bi.dashboards.create', 'bi.dashboards.edit',
      'bi.reports.view', 'bi.reports.create', 'bi.reports.export', 'bi.reports.schedule',
    ],
    nav: [
      { label: 'Dashboards', path: '/bi', icon: 'LayoutDashboard', permission: 'bi.dashboards.view' },
      { label: 'Reports', path: '/bi/reports', icon: 'FileBarChart', permission: 'bi.reports.view' },
      { label: 'Scheduled', path: '/bi/scheduled', icon: 'Clock', permission: 'bi.reports.schedule' },
    ],
    widgets: [],
    dependencies: [],
  },

  // ══════════════════════════════════════════════════════════════ DEVELOPER
  {
    slug: 'automation',
    name: 'Automation',
    tagline: 'If this, then that — across every app',
    description:
      'Build rules that watch for something happening in one app and act in another. No code, no glue scripts.',
    category: 'developer',
    icon: 'Workflow',
    color: 'purple',
    service: 'automation',
    price: price(599),
    flagship: true,
    highlights: ['Visual rule builder', 'Cross-app triggers', 'Scheduled jobs', 'Full run history'],
    features: ['automation.rules', 'automation.triggers', 'automation.actions', 'automation.history'],
    permissions: [
      'automation.rules.view', 'automation.rules.create', 'automation.rules.edit',
      'automation.rules.delete', 'automation.history.view',
    ],
    nav: [
      { label: 'Rules', path: '/automation', icon: 'Workflow', permission: 'automation.rules.view' },
      { label: 'Run history', path: '/automation/history', icon: 'History', permission: 'automation.history.view' },
    ],
    widgets: [{ id: 'automation.runs', title: 'Automation runs', size: 'md', permission: 'automation.history.view' }],
    dependencies: [],
  },
  {
    slug: 'integrations',
    name: 'Integrations',
    tagline: 'Connect the tools you already pay for',
    description:
      'Pre-built connectors for WhatsApp, Google, Microsoft, Shopify, payment gateways and shipping — plus webhooks and a REST API for everything else.',
    category: 'developer',
    icon: 'Plug',
    color: 'purple',
    service: 'integrations',
    price: price(399),
    highlights: ['WhatsApp & email', 'Google & Microsoft', 'Payment gateways', 'Webhooks & REST API'],
    features: ['integrations.connectors', 'integrations.webhooks', 'integrations.api_keys'],
    permissions: [
      'integrations.connectors.view', 'integrations.connectors.manage',
      'integrations.webhooks.view', 'integrations.webhooks.manage',
      'integrations.keys.view', 'integrations.keys.manage',
    ],
    nav: [
      { label: 'Connectors', path: '/integrations', icon: 'Plug', permission: 'integrations.connectors.view' },
      { label: 'Webhooks', path: '/integrations/webhooks', icon: 'Webhook', permission: 'integrations.webhooks.view' },
      { label: 'API keys', path: '/integrations/keys', icon: 'KeyRound', permission: 'integrations.keys.view' },
    ],
    widgets: [],
    dependencies: [],
  },
];

// Release availability is explicit: catalogue descriptions are not shipped services.
const RELEASED_APPS = new Set(['core', 'crm', 'hr', 'payroll', 'documents', 'invoicing', 'tasks']);
for (const app of APPS) app.status = RELEASED_APPS.has(app.slug) ? 'available' : 'coming_soon';

const BY_SLUG = new Map(APPS.map((a) => [a.slug, a]));
const BY_CATEGORY = new Map(APP_CATEGORIES.map((c) => [c.slug, c]));

export const appBySlug = (slug) => BY_SLUG.get(slug) ?? null;
export const categoryBySlug = (slug) => BY_CATEGORY.get(slug) ?? null;

export const allPermissions = () => APPS.flatMap((a) => a.permissions);

export const appPermissions = (slug) => appBySlug(slug)?.permissions ?? [];

/** Apps a customer can actually buy today — the marketplace's default view. */
export const availableApps = () => APPS.filter((a) => !a.core && a.status !== 'coming_soon');

/** The handful we lead with on the marketing site. */
export const flagshipApps = () => APPS.filter((a) => a.flagship);

export const appsByCategory = (slug) => APPS.filter((a) => !a.core && a.category === slug);

/** Every distinct service this platform deploys, in registry order. */
export const allServices = () => [...new Set(APPS.map((a) => a.service))];

/**
 * Returns the full set of apps required to install `slugs`, in install order.
 * Throws on an unknown app or a dependency cycle.
 */
export function resolveDependencies(slugs) {
  const ordered = [];
  const seen = new Set();
  const visiting = new Set();

  const visit = (slug, trail = []) => {
    if (seen.has(slug)) return;
    if (visiting.has(slug)) {
      throw new Error(`circular app dependency: ${[...trail, slug].join(' → ')}`);
    }
    const app = BY_SLUG.get(slug);
    if (!app) throw new Error(`unknown app: ${slug}`);

    visiting.add(slug);
    for (const dep of app.dependencies ?? []) visit(dep, [...trail, slug]);
    visiting.delete(slug);

    seen.add(slug);
    ordered.push(slug);
  };

  for (const slug of slugs) visit(slug);
  return ordered;
}

/** Apps that would break if `slug` were removed from a given selection. */
export function dependentsOf(slug, within = APPS.map((a) => a.slug)) {
  return within.filter((other) => (BY_SLUG.get(other)?.dependencies ?? []).includes(slug));
}
