import { For, splitProps, type JSX } from 'solid-js';
import { routePath, type Route } from './navigation';

type RouteLinkProps = {
  route: Route;
  choose: () => void;
  children?: JSX.Element;
} & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>;

export function RouteLink(props: RouteLinkProps) {
  const [local, anchor] = splitProps(props, ['route', 'choose', 'children']);
  return <a {...anchor} href={routePath(local.route)} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    local.choose();
  }}>{local.children}</a>;
}

export function WorkspaceLinks(props: {
  label: string;
  links: { label: string; route: Route }[];
  route: Route;
  go: (route: Route) => void;
}) {
  return <nav class="workspace-links" aria-label={props.label}>
    <For each={props.links}>{link => <RouteLink route={link.route} choose={() => props.go(link.route)}
      aria-current={routePath(props.route) === routePath(link.route) ? 'page' : undefined}>{link.label}</RouteLink>}</For>
  </nav>;
}
