package sqlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func importNames(file *ast.File) map[string]string {
	names := map[string]string{}
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			continue
		}
		name := path[strings.LastIndex(path, "/")+1:]
		if imp.Name != nil {
			name = imp.Name.Name
		}
		names[name] = path
	}
	return names
}

func isTxParam(field *ast.Field) bool {
	star, ok := field.Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "sql" && sel.Sel.Name == "Tx"
}

func takesTx(ft *ast.FuncType) bool {
	if ft == nil || ft.Params == nil {
		return false
	}
	for _, f := range ft.Params.List {
		if isTxParam(f) {
			return true
		}
	}
	return false
}

func isForbidden(path, member string) bool {
	return path == "net" || strings.HasPrefix(path, "net/") || (path == "time" && member == "Sleep")
}

type scanned struct {
	violations []string
	callees    []string
}

func scanBody(fset *token.FileSet, imports map[string]string, body ast.Node, owner string) scanned {
	var out scanned
	ast.Inspect(body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.SelectorExpr:
			if id, ok := v.X.(*ast.Ident); ok {
				if path, imported := imports[id.Name]; imported && isForbidden(path, v.Sel.Name) {
					out.violations = append(out.violations, fset.Position(v.Pos()).String()+": "+owner+" uses "+path+"."+v.Sel.Name)
				}
			}
		case *ast.CallExpr:
			switch fn := v.Fun.(type) {
			case *ast.Ident:
				out.callees = append(out.callees, fn.Name)
			case *ast.SelectorExpr:
				out.callees = append(out.callees, fn.Sel.Name)
			}
		}
		return true
	})
	return out
}

func txBodyViolations(fset *token.FileSet, files []*ast.File) (violations []string, roots int) {
	type decl struct {
		fn      *ast.FuncDecl
		imports map[string]string
	}
	decls := map[string][]decl{}
	type root struct {
		node    ast.Node
		name    string
		imports map[string]string
	}
	var rootList []root
	for _, file := range files {
		imports := importNames(file)
		for _, d := range file.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			decls[fn.Name.Name] = append(decls[fn.Name.Name], decl{fn: fn, imports: imports})
			if takesTx(fn.Type) {
				rootList = append(rootList, root{node: fn.Body, name: fn.Name.Name, imports: imports})
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if lit, ok := n.(*ast.FuncLit); ok && takesTx(lit.Type) {
					rootList = append(rootList, root{node: lit.Body, name: fn.Name.Name + ".func", imports: imports})
				}
				return true
			})
		}
	}
	visited := map[string]bool{}
	var queue []string
	for _, r := range rootList {
		res := scanBody(fset, r.imports, r.node, r.name)
		violations = append(violations, res.violations...)
		queue = append(queue, res.callees...)
	}
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if visited[name] {
			continue
		}
		visited[name] = true
		for _, d := range decls[name] {
			res := scanBody(fset, d.imports, d.fn.Body, name)
			violations = append(violations, res.violations...)
			queue = append(queue, res.callees...)
		}
	}
	sort.Strings(violations)
	return violations, len(rootList)
}

func parseSources(t *testing.T, fset *token.FileSet, sources map[string]string) []*ast.File {
	t.Helper()
	var files []*ast.File
	for name, src := range sources {
		f, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files = append(files, f)
	}
	return files
}

func TestNoNetworkOrSleepInTransaction(t *testing.T) {
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	var files []*ast.File
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files = append(files, f)
	}
	violations, roots := txBodyViolations(fset, files)
	if roots == 0 {
		t.Fatal("no transaction bodies found; check is vacuous")
	}
	if len(violations) > 0 {
		t.Fatalf("forbidden calls reachable from transaction bodies:\n%s", strings.Join(violations, "\n"))
	}
}

func TestTxGuardDetectsForbiddenCalls(t *testing.T) {
	cases := map[string]string{
		"sleep in body": `package x
import ("database/sql"; "time")
func run(tx *sql.Tx) error { time.Sleep(1); return nil }`,
		"http through helper": `package x
import ("database/sql"; "net/http")
func run(tx *sql.Tx) error { return fetch() }
func fetch() error { _, err := http.Get("http://example.invalid"); return err }`,
		"net in closure": `package x
import ("database/sql"; "net")
func build() func(*sql.Tx) error { return func(tx *sql.Tx) error { _, err := net.Dial("tcp", "x"); return err } }`,
		"sleep two helpers deep": `package x
import ("database/sql"; "time")
func run(tx *sql.Tx) error { return a() }
func a() error { return b() }
func b() error { time.Sleep(1); return nil }`,
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			fset := token.NewFileSet()
			violations, roots := txBodyViolations(fset, parseSources(t, fset, map[string]string{"fixture.go": src}))
			if roots == 0 || len(violations) == 0 {
				t.Fatalf("roots=%d violations=%v, want a violation", roots, violations)
			}
		})
	}

	clean := `package x
import ("database/sql"; "time")
func run(tx *sql.Tx) error { return nil }
func outside() { time.Sleep(1) }`
	fset := token.NewFileSet()
	violations, _ := txBodyViolations(fset, parseSources(t, fset, map[string]string{"clean.go": clean}))
	if len(violations) != 0 {
		t.Fatalf("unreachable sleep flagged: %v", violations)
	}
}
