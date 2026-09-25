import TasksClient from './tasks-client';
export const metadata = { title: 'Projects & Tasks' };
export default function Page() { return <TasksClient view="work" />; }
