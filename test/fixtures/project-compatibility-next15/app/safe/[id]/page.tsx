type PageProps = { params: Promise<{ id: string }> };

export default async function SafePage({ params }: PageProps) {
  const { id } = await params;
  return <p>User {id}</p>;
}
