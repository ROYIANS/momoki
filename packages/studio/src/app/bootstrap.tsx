import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {createRouter, RouterProvider} from "@tanstack/react-router";
import {routeTree} from "./routeTree.gen";
import {initUmami} from "@momoki/distribution/analytics";
import {getHistoryNavigation} from "./navigation/historyNavigation";
import {createProductRouterHistory} from "./navigation/productRouterHistory";
import {installNativeExternalLinks} from "../platform/runtime/runtimeExternalLinks";
import {initializeProductStorage} from "../platform/product/store";
import {initModelCatalog} from "../features/settings/modelCatalog/store";
import {ErrorFallback, NotFound} from "./errors/ErrorFallback";
import {RootErrorBoundary, RootErrorFallback} from "./errors/RootErrorFallback";
import {ErrorDetailsDialog} from "./errors/ErrorDetailsDialog";
import {installGlobalErrorHandlers} from "./errors/showError";
import {addBreadcrumb} from "../platform/diagnostics/breadcrumbs";
import {reportError} from "../platform/diagnostics/reportError";
import {handleBrowserMcpCallback} from "../platform/runtime/browserMcpCallback";
import {initializeAgentExecution} from "../features/agent/runtime/agentExecution";
import {installBrowserMcpRuntime} from "../features/agent/mcp/runtime/browserRuntime";
import {installDesktopApplicationLifecycle} from "./lifecycle/desktopApplication";

function createApplicationRouter() {return createRouter({
    routeTree,
    history: createProductRouterHistory(),
    defaultErrorComponent: ErrorFallback,
    defaultNotFoundComponent: NotFound,
    defaultOnCatch: error => {
        reportError(error, {source: "boundary"});
    },
});}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof createApplicationRouter>;
    }
}

function mountApplication(): void {
    initUmami();
    installNativeExternalLinks();
    const router = createApplicationRouter();
    getHistoryNavigation(router.history);
    router.subscribe("onResolved", event => addBreadcrumb("route", event.toLocation.pathname));
    installGlobalErrorHandlers();
    const root = document.getElementById("root");
    if (!root) throw new Error("root element missing");

    const applicationRoot = createRoot(root, {
        onCaughtError: error => {
            reportError(error, {source: "boundary"});
        },
        onUncaughtError: error => {
            reportError(error, {source: "global"});
        },
        onRecoverableError: error => {
            reportError(error, {source: "global"});
        },
    });

    async function startApplication(): Promise<void> {
        try {
            await initializeProductStorage();
            await installBrowserMcpRuntime();
            await initializeAgentExecution();
            await installDesktopApplicationLifecycle();
            // Not awaited: the catalog is advisory and must not delay first paint. It never rejects, and
            // beginAgentRun awaits the same memoized promise before creating a run.
            void initModelCatalog();
            applicationRoot.render(
                <StrictMode>
                    <RootErrorBoundary>
                        <RouterProvider router={router}/>
                    </RootErrorBoundary>
                    <ErrorDetailsDialog/>
                </StrictMode>,
            );
        } catch (cause) {
            reportError(cause, {source: "boundary"});
            applicationRoot.render(
                <>
                    <RootErrorFallback
                        title="工作区无法打开"
                        description="本机存储初始化失败。请关闭应用后重新打开；现有文件会保留。"
                        error={cause}
                    />
                    <ErrorDetailsDialog/>
                </>,
            );
        }
    }

    void startApplication();
}

if (!handleBrowserMcpCallback(window)) mountApplication();
