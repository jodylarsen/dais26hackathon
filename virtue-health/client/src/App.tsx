import { createBrowserRouter, RouterProvider, NavLink, Outlet, useRouteError } from 'react-router';
import { useState, useEffect } from 'react';
import { ErrorBoundary, ErrorDisplay } from './ErrorBoundary';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Menu, Activity } from 'lucide-react';
import { OverviewPage } from './pages/overview/OverviewPage';
import { FacilitiesPage } from './pages/facilities/FacilitiesPage';
import { DistrictsPage } from './pages/districts/DistrictsPage';
import { DesertPage } from './pages/desert/DesertPage';
import { DataReadinessPage } from './pages/data-readiness/DataReadinessPage';

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-[#FF3621] text-white'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

type NavLinkClassFn = (props: { isActive: boolean }) => string;

function NavLinks({
  className,
  linkClass,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  onClick?: () => void;
}) {
  return (
    <nav className={className}>
      <NavLink to="/" end className={linkClass} onClick={onClick}>
        Overview
      </NavLink>
      <NavLink to="/facilities" className={linkClass} onClick={onClick}>
        Facilities
      </NavLink>
      <NavLink to="/districts" className={linkClass} onClick={onClick}>
        Districts
      </NavLink>
      <NavLink to="/desert" className={linkClass} onClick={onClick}>
        Desert Planner
      </NavLink>
      <NavLink to="/data-readiness" className={linkClass} onClick={onClick}>
        Data Readiness
      </NavLink>
    </nav>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, [isMobile]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header
        className="border-b px-4 md:px-6 py-3 flex items-center gap-4"
        style={{ backgroundColor: '#0B2026' }}
      >
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md bg-[#FF3621] flex items-center justify-center shrink-0">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <h1 className="text-base font-semibold text-white tracking-tight">Virtue Health</h1>
          <span className="text-[10px] font-semibold bg-white/15 text-white/70 px-1.5 py-0.5 rounded tracking-wide hidden sm:inline">DAIS 2026</span>
        </div>

        {/* Desktop nav */}
        <div className="hidden md:flex gap-1 ml-4">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            Overview
          </NavLink>
          <NavLink
            to="/facilities"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            Facilities
          </NavLink>
          <NavLink
            to="/districts"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            Districts
          </NavLink>
          <NavLink
            to="/desert"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            Desert Planner
          </NavLink>
          <NavLink
            to="/data-readiness"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            Data Readiness
          </NavLink>
        </div>

        {/* Mobile nav */}
        <div className="ml-auto md:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileNavOpen(true)}
              className="text-white hover:bg-white/10"
            >
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation</span>
            </Button>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Virtue Health</SheetTitle>
              </SheetHeader>
              <NavLinks
                className="flex flex-col gap-1 mt-4"
                linkClass={mobileNavLinkClass}
                onClick={() => setMobileNavOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6 bg-background">
        <Outlet />
      </main>
    </div>
  );
}

function RouteErrorPage() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return (
    <div className="min-h-screen bg-background">
      <ErrorDisplay message={message} onRetry={() => window.location.reload()} />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/', element: <OverviewPage />, errorElement: <RouteErrorPage /> },
      { path: '/facilities', element: <FacilitiesPage />, errorElement: <RouteErrorPage /> },
      { path: '/districts', element: <DistrictsPage />, errorElement: <RouteErrorPage /> },
      { path: '/desert', element: <DesertPage />, errorElement: <RouteErrorPage /> },
      { path: '/data-readiness', element: <DataReadinessPage />, errorElement: <RouteErrorPage /> },
    ],
  },
]);

export default function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}
