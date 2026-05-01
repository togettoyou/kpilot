export default function access(
  initialState: { currentUser?: { name: string; access: string } } | undefined,
) {
  const { currentUser } = initialState ?? {};
  return {
    canAdmin: currentUser && currentUser.access === 'admin',
  };
}
