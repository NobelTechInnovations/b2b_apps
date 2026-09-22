import SettingsNav from './settings-nav';

export const metadata = { title: 'Settings' };

export default function SettingsLayout({ children }) {
  return (
    <div className="flex flex-col gap-8 lg:flex-row">
      <SettingsNav />
      <div className="min-w-0 flex-1 pb-10">{children}</div>
    </div>
  );
}
