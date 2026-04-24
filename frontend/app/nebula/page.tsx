import { redirect } from 'next/navigation';

// /nebula was a duplicate of the Archive — redirect to the canonical URL
export default function NebulaPage() {
  redirect('/archive');
}
