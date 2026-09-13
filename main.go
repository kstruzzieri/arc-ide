package main

import (
	"embed"
	"log"
	goruntime "runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// firnWindowBackground is the ground every Firn window paints before the
// frontend does. One source, so the Golem window can never drift from main.
var firnWindowBackground = application.NewRGB(2, 6, 23)

// menuEvent hands a menu accelerator to the frontend with main in front of the
// user (#271 §5.3). The application menu is global — macOS serves it from the
// NSApp menu whatever has focus, and the Golem satellite sets
// UseApplicationMenu so Windows and Linux attach it there too — so Go Back
// pressed in the satellite would otherwise navigate an editor in a window that
// is behind it, or minimised. focusMainWindow is a no-op during a permitted
// quit, which is the one time nothing may be revealed.
func (a *App) menuEvent(event string) {
	a.focusMainWindow()
	a.emit(event, nil)
}

func buildAppMenu(app *App, wapp *application.App) *application.Menu {
	menu := wapp.Menu.New()

	// A custom menu replaces the macOS default entirely. Without the standard
	// App and Edit menus, the OS never wires Cmd+C/V/X/A or Cmd+Q to the
	// webview's responder chain, so copy/paste is dead in every text field.
	// Other platforms handle clipboard natively and need no menu entry.
	if goruntime.GOOS == "darwin" {
		menu.AddRole(application.AppMenu)
		menu.AddRole(application.EditMenu)
	}

	navigateMenu := menu.AddSubmenu("Navigate")
	navigateMenu.Add("Go Back").SetAccelerator("CmdOrCtrl+[").OnClick(func(_ *application.Context) {
		app.menuEvent("navigate:back")
	})
	navigateMenu.Add("Go Forward").SetAccelerator("CmdOrCtrl+]").OnClick(func(_ *application.Context) {
		app.menuEvent("navigate:forward")
	})

	workspaceMenu := menu.AddSubmenu("Workspace")
	workspaceMenu.Add("Switch Workspace").SetAccelerator("CmdOrCtrl+Shift+.").OnClick(func(_ *application.Context) {
		app.menuEvent("menu:switch-workspace")
	})

	return menu
}

// golemScreenAreas orders the display work areas #271's placement sees. The
// first area is the fallback a satellite is centred on when its saved display
// is gone.
func golemScreenAreas(screens []*application.Screen, mainWindow application.Window) []application.Rect {
	areas := make([]application.Rect, 0, len(screens)+1)
	for _, screen := range screens {
		if screen == nil {
			continue
		}
		if screen.IsPrimary {
			areas = append([]application.Rect{screen.WorkArea}, areas...)
			continue
		}
		areas = append(areas, screen.WorkArea)
	}
	// Main's own screen leads: §5.3 centres a satellite whose saved display is
	// gone on main's screen, not on the primary. The primary stays next, so it
	// still leads when main reports no screen at all.
	if window := asLiveWindow(mainWindow); window != nil {
		if screen, err := window.GetScreen(); err == nil && screen != nil {
			areas = append([]application.Rect{screen.WorkArea}, areas...)
		}
	}
	return areas
}

func main() {
	app := NewApp()

	wapp := application.New(application.Options{
		Name:        "Firn",
		Description: "A lightweight, workspace-focused IDE for macOS, Linux, and Windows",
		Services: []application.Service{
			application.NewService(app),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			// v2 quit-on-window-close parity; v3 default keeps the app running.
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		ShouldQuit: app.shouldQuit,
	})
	app.v3app = wapp

	// #271: the native seams the Golem window state machine needs, installed
	// once here so no bound call ever mutates a function field concurrently.
	// golemScreenAreas orders the work areas: main's own screen first (the
	// placement fallback when a saved window's display is gone), then the
	// primary, then the rest.
	app.golemWindowFactory = func(options application.WebviewWindowOptions) application.Window {
		// Unstarted: main.go's own handle and hooks are installed before the
		// window is registered and run, so a bootstrap cannot race them.
		return application.NewWindow(options)
	}
	app.screenBounds = func() []application.Rect {
		return golemScreenAreas(wapp.Screen.GetAll(), app.mainWindow)
	}
	app.golemWindowPresent = func(id uint) bool {
		_, present := wapp.Window.GetByID(id)
		return present
	}

	wapp.Menu.Set(buildAppMenu(app, wapp))

	win := wapp.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             golemWindowNameMain,
		Title:            "Firn",
		Width:            1440,
		Height:           900,
		MinWidth:         1024,
		MinHeight:        600,
		BackgroundColour: firnWindowBackground,
		// Windows attaches the global menu to a window only when this is true.
		// Linux already falls back to the global menu on its own, and macOS
		// ignores the flag and always uses the NSApp menu.
		UseApplicationMenu: true,
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBar{
				AppearsTransparent: true,
				Hide:               false,
				HideTitle:          true,
				FullSizeContent:    true,
				UseToolbar:         false,
			},
			Appearance: application.NSAppearanceNameDarkAqua,
			// WKWebView defaults to "Tab moves between text fields only" unless
			// macOS Full Keyboard Access is on, so buttons, links and every
			// other non-text control were unreachable by keyboard. Firn is an
			// IDE: Tab visits all controls, as it does in a browser.
			WebviewPreferences: application.MacWebviewPreferences{
				TabFocusesLinks: application.Enabled,
			},
		},
	})
	app.mainWindow = win

	// #271: the persisted Golem window preference is loaded once; the frontend
	// restores an undocked window itself once its chat owner is ready.
	app.loadGolemWindowPreference()

	// The main window close button starts the quit handshake instead of closing
	// directly. The permitted transition issues the one final platform Quit.
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		app.handleMainWindowClosing(e.Cancel)
	})

	if err := wapp.Run(); err != nil {
		log.Fatalf("Error starting Firn IDE: %v", err)
	}
}
