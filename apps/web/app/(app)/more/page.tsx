import { redirect } from 'next/navigation';

/** More was folded into Settings; old links and bookmarks land there. */
export default function MorePage(): never {
  redirect('/settings');
}
