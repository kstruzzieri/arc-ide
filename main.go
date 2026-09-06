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
		app.emit("navigate:back", nil)
	})
	navigateMenu.Add("Go Forward").SetAccelerator("CmdOrCtrl+]").OnClick(func(_ *application.Context) {
		app.emit("navigate:forward", nil)
	})

	workspaceMenu := menu.AddSubmenu("Workspace")
	workspaceMenu.Add("Switch Workspace").SetAccelerator("CmdOrCtrl+Shift+.").OnClick(func(_ *application.Context) {
		app.emit("menu:switch-workspace", nil)
	})

	return menu
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
	// The primary screen leads, because it is the placement fallback when a
	// saved window's display is gone.
	app.golemWindowFactory = func(options application.WebviewWindowOptions) application.Window {
		// Unstarted: main.go's own handle and hooks are installed before the
		// window is registered and run, so a bootstrap cannot race them.
		return application.NewWindow(options)
	}
	app.screenBounds = func() []application.Rect {
		screens := wapp.Screen.GetAll()
		areas := make([]application.Rect, 0, len(screens))
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
		return areas
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
		BackgroundColour: application.NewRGB(2, 6, 23),
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
