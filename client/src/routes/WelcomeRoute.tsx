import { AuthContextProvider } from '~/hooks/AuthContext';
import Landing from '~/components/Discover/Landing';

/** OmicsBase: the public landing page; signed-in visitors go on to a new note. */
export default function WelcomeRoute() {
  return (
    <AuthContextProvider authConfig={{ loginRedirect: '/login', optional: true }}>
      <Landing />
    </AuthContextProvider>
  );
}
