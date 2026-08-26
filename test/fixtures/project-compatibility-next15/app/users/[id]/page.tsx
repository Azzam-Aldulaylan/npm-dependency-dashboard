type PageProps = { params: { id: string } };

export default function UserPage({ params }: PageProps) {
  return <p>User {params.id}</p>;
}
